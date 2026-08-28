/**
 * =========================================================
 * ALTIGUARD - SCRIPT.JS (CLIENT ENGINE)
 * =========================================================
 * Handles UI interactions, Socket.io syncing, Live GPS tracking,
 * Leaflet Map rendering, and SVG Graphing.
 */

(function () {
    "use strict";

    // 1. STATE & GLOBAL VARIABLES
    const socket = io();
    let currentRole = "worker";
    let currentGroupCode = null;
    let mySelfId = null;
    let liveTrackingId = null;
    let gpsWatchId = null;
    let group = [];
    let logs = [];
    let globalBaseline = 0;
    let map = null;
    let markers = {};
    let kinematicHistory = []; // For drop detection

    // UI Elements
    const statRole = document.getElementById("statRole");
    const statActive = document.getElementById("statActive");
    const emptyHint = document.getElementById("emptyHint");
    const rosterList = document.getElementById("rosterList");
    const graphSvg = document.getElementById("graphSvg");
    const alertBanner = document.getElementById("alertBanner");
    const logList = document.getElementById("logList");

    // 2. SOCKET LISTENERS
    socket.on('roleAssigned', (data) => {
        currentRole = data.role;
        currentGroupCode = data.groupCode;
        statRole.textContent = currentRole.toUpperCase();
        document.getElementById("groupCodeInput").value = currentGroupCode;
        showAlert(`Connected to ${currentGroupCode} as ${currentRole.toUpperCase()}`);
        renderUI();
    });

    socket.on('syncGroup', (members) => {
        group = members;
        renderUI();
    });

    socket.on('syncBaseline', (baseline) => {
        globalBaseline = baseline;
        const refInput = document.getElementById("referenceInput");
        if (refInput) refInput.value = baseline;
        renderUI();
    });

    socket.on('receiveAlert', (alertData) => {
        showAlert(`⚠️ ALERT: ${alertData.name} dropped ${alertData.drop}m!`);
        logEvent(`⚠️ Fall detected: ${alertData.name} (${alertData.drop}m)`);
        triggerBeep();
    });

    socket.on('receiveSOS', (payload) => {
        showAlert(`🚨 SOS: ${payload.name} initiated an emergency!`);
        logEvent(`🚨 SOS Activated by ${payload.name}`);
        triggerBeep();
    });

    socket.on('groupError', (msg) => {
        showAlert(`❌ Error: ${msg}`);
    });

    socket.on('aiInsightResponse', (res) => {
        const modal = document.getElementById("aiModal");
        modal.innerHTML = res.error ? `❌ ${res.error}` : `🤖 <strong>AI Audit:</strong><br>${res.result}`;
        modal.hidden = false;
        setTimeout(() => { modal.hidden = true; }, 10000);
        document.getElementById("aiAdvisorBtn").textContent = "✨ AI Audit";
    });

    // 3. UI INTERACTIONS (DASHBOARD)
    document.getElementById("createGroupBtn").addEventListener("click", () => {
        const code = document.getElementById("groupCodeInput").value;
        socket.emit('createGroup', code);
    });

    document.getElementById("joinGroupActionBtn").addEventListener("click", () => {
        const code = document.getElementById("groupCodeInput").value;
        if (!code) return showAlert("Please enter a Site Code.");
        socket.emit('joinGroup', code);
    });

    // Toggle Manual Fields
    const manualFields = document.getElementById("manualFields");
    let isManual = false;
    document.getElementById("manualToggle").addEventListener("click", () => {
        isManual = !isManual;
        manualFields.hidden = !isManual;
        document.getElementById("addBtn").disabled = false;
    });

    // Capture Button (Auto GPS)
    document.getElementById("captureBtn").addEventListener("click", () => {
        document.getElementById("addBtn").disabled = false;
        showAlert("GPS Ready. Fill in your name and click Inject.");
        isManual = false;
        manualFields.hidden = true;
    });

    // Add Operator Form
    document.getElementById("addForm").addEventListener("submit", (e) => {
        const name = document.getElementById("nameInput").value.trim();
        if (!name) return;

        if (!mySelfId) mySelfId = "OP-" + Math.random().toString(36).slice(2, 8).toUpperCase();
        
        let initialHeight = 0;
        if (isManual) {
            initialHeight = parseFloat(document.getElementById("manualHeight").value) || 0;
        }

        const person = {
            id: mySelfId,
            name: name,
            height: initialHeight,
            lat: null,
            lon: null,
            method: isManual ? "manual" : "auto"
        };

        // If they already exist, update them. Otherwise add.
        const existingIndex = group.findIndex(p => p.id === mySelfId);
        if (existingIndex > -1) {
            group[existingIndex] = person;
        } else {
            group.push(person);
        }

        socket.emit('updateGroupData', group);
        document.getElementById("nameInput").value = "";
        
        if (!isManual) {
            startTracking(mySelfId);
        }
        renderUI();
    });

    // Physics Settings
    document.getElementById("setRefBtn").addEventListener("click", () => {
        const val = parseFloat(document.getElementById("referenceInput").value) || 0;
        socket.emit('setBaseline', val);
    });

    document.getElementById("testAlertBtn").addEventListener("click", () => {
        const testData = { name: "System Test", drop: 1.5 };
        socket.emit('triggerFallAlert', testData);
        showAlert(`⚠️ TEST ALERT INITIATED`);
        logEvent("Test alert broadcasted.");
    });

    // FAB Buttons
    document.getElementById("sosTriggerBtn").addEventListener("click", () => {
        if (!mySelfId) return showAlert("You must inject into the grid to use SOS.");
        const me = group.find(p => p.id === mySelfId);
        socket.emit('triggerSOS', { name: me.name, lat: me.lat, lon: me.lon });
    });

    document.getElementById("aiAdvisorBtn").addEventListener("click", (e) => {
        e.target.textContent = "⏳ Analyzing...";
        let maxH = 0;
        if(group.length > 0) maxH = Math.max(...group.map(p => p.height));
        socket.emit('requestAiInsight', { workerCount: group.length, highestElevation: maxH });
    });

    // 4. LIVE GPS TRACKING
    function startTracking(personId) {
        if (!navigator.geolocation) {
            return showAlert("Geolocation is not supported by your browser.");
        }
        
        stopTracking(); // Clear any existing tracking
        liveTrackingId = personId;
        
        gpsWatchId = navigator.geolocation.watchPosition((pos) => {
            const person = group.find(p => p.id === liveTrackingId);
            if (person) {
                person.lat = pos.coords.latitude;
                person.lon = pos.coords.longitude;
                person.height = pos.coords.altitude || person.height; // Fallback to current if altitude unavailable
                
                checkKinematicDrop(person);
                socket.emit('updateGroupData', group);
                renderUI();
            }
        }, (err) => {
            showAlert(`GPS Error: ${err.message}`);
        }, { enableHighAccuracy: true, maximumAge: 0 });
    }

    function stopTracking() {
        if (gpsWatchId) navigator.geolocation.clearWatch(gpsWatchId);
        liveTrackingId = null;
        gpsWatchId = null;
        renderUI();
    }

    // 5. KINEMATIC FALL ALGORITHM
    function checkKinematicDrop(person) {
        const now = Date.now();
        const dropThreshold = parseFloat(document.getElementById("dropInput").value) || 1.5;
        const windowSec = parseInt(document.getElementById("windowInput").value) || 4;
        
        kinematicHistory.push({ time: now, h: person.height });
        
        // Clean old history
        kinematicHistory = kinematicHistory.filter(entry => now - entry.time <= windowSec * 1000);
        
        if (kinematicHistory.length >= 2) {
            const peak = Math.max(...kinematicHistory.map(e => e.h));
            const drop = peak - person.height;
            if (drop >= dropThreshold) {
                socket.emit('triggerFallAlert', { name: person.name, drop: drop.toFixed(2), id: person.id });
                kinematicHistory = []; // Reset to avoid duplicate alerts
            }
        }
    }

    // 6. MASTER RENDER ENGINE
    function renderUI() {
        statActive.textContent = `${group.length} Tracked`;
        
        if (group.length === 0) {
            emptyHint.style.display = "flex";
            rosterList.innerHTML = "";
            graphSvg.innerHTML = "";
        } else {
            emptyHint.style.display = "none";
            renderRoster();
            renderGraph();
        }
        renderMap();
    }

    function renderRoster() {
        rosterList.innerHTML = group.map(p => {
            const relHeight = p.height - globalBaseline;
            const limit = parseFloat(document.getElementById("limitInput").value) || 2;
            const statusClass = relHeight > limit ? "status-above" : relHeight < -limit ? "status-below" : "status-within";
            const isLive = p.id === liveTrackingId;
            const isMe = p.id === mySelfId;
            
            let actionBtns = "";
            
            // Only Admin can remove others. Workers can only remove themselves.
            if (currentRole === "admin" || isMe) {
                actionBtns += `<button class="mini-btn remove-btn" onclick="removeNode('${p.id}')">✕ Eject</button>`;
            }
            
            // Admin can toggle tracking for others (simulated), or people toggle themselves
            if (currentRole === "admin" || isMe) {
                actionBtns += `<button class="mini-btn track-btn ${isLive ? 'active' : ''}" onclick="toggleTrack('${p.id}')">
                    ${isLive ? "⏹ Halt GPS" : "📍 Track GPS"}
                </button>`;
            }

            return `
                <li class="roster-item ${isLive ? 'is-live' : ''}">
                    <div class="roster-info">
                        <strong>${currentRole === 'admin' && p.id === group[0].id ? '👑 ' : ''}${p.name}</strong>
                        <span class="roster-sub">Raw Z: ${p.height.toFixed(2)}m</span>
                    </div>
                    <div class="roster-status ${statusClass}">${(relHeight >= 0 ? "+" : "")}${relHeight.toFixed(2)}m</div>
                    <div class="roster-actions">${actionBtns}</div>
                </li>
            `;
        }).join('');
    }

    function renderGraph() {
        const W = graphSvg.clientWidth || 600;
        const H = graphSvg.clientHeight || 400;
        const padding = 40;
        
        const limit = parseFloat(document.getElementById("limitInput").value) || 2;
        const rels = group.map(p => p.height - globalBaseline);
        const maxAbs = Math.max(limit * 1.5, ...rels.map(Math.abs), 1);
        
        const scaleY = (H / 2 - padding) / maxAbs;
        const midY = H / 2;

        let svgHtml = `
            <!-- Baseline -->
            <line class="baseline" x1="10" y1="${midY}" x2="${W - 10}" y2="${midY}"></line>
            <text class="axis-label" x="${W - 30}" y="${midY - 10}">DATUM 0m</text>
        `;

        group.forEach((p, i) => {
            const rel = p.height - globalBaseline;
            const x = padding + ((W - padding * 2) * (i + 0.5)) / group.length;
            const y = midY - (rel * scaleY);
            
            const status = rel > limit ? "above" : rel < -limit ? "below" : "within";
            const liveClass = p.id === liveTrackingId ? "figure-live" : "";

            svgHtml += `
                <g class="figure figure-${status} ${liveClass}" style="transform: translate(${x}px, ${y}px)">
                    ${p.id === liveTrackingId ? '<circle class="live-halo" r="16"></circle>' : ''}
                    <text class="figure-readout" x="0" y="-30" text-anchor="middle">${(rel >= 0 ? "+" : "")}${rel.toFixed(2)}m</text>
                    <circle class="figure-head" cx="0" cy="-15" r="7"></circle>
                    <line class="figure-body" x1="0" y1="-8" x2="0" y2="12"></line>
                    <text class="figure-label" x="0" y="30" text-anchor="middle">${p.name}</text>
                </g>
            `;
        });

        graphSvg.innerHTML = svgHtml;
    }

    function renderMap() {
        if (!map && typeof L !== "undefined") {
            map = L.map('map').setView([20.5937, 78.9629], 5);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; CARTO',
                maxZoom: 19
            }).addTo(map);
        }
        if (!map) return;

        // Sync markers
        const activeIds = group.map(p => p.id);
        for (let id in markers) {
            if (!activeIds.includes(id)) {
                map.removeLayer(markers[id]);
                delete markers[id];
            }
        }

        group.forEach(p => {
            if (p.lat && p.lon) {
                if (markers[p.id]) {
                    markers[p.id].setLatLng([p.lat, p.lon]);
                } else {
                    const iconHtml = `<svg width="20" height="20" viewBox="0 0 24 24" fill="${p.id === liveTrackingId ? '#f59e0b' : '#38bdf8'}"><circle cx="12" cy="12" r="10" stroke="#fff" stroke-width="2"/></svg>`;
                    const divIcon = L.divIcon({ className: 'tactical-marker', html: iconHtml, iconSize: [20,20] });
                    markers[p.id] = L.marker([p.lat, p.lon], { icon: divIcon }).addTo(map).bindPopup(`<b>${p.name}</b><br>Z: ${p.height.toFixed(2)}m`);
                }
            }
        });
    }

    // 7. UTILITIES
    window.toggleTrack = function(id) {
        if (liveTrackingId === id) stopTracking();
        else startTracking(id);
    };

    window.removeNode = function(id) {
        if (liveTrackingId === id) stopTracking();
        socket.emit('removePerson', id);
    };

    function showAlert(msg) {
        alertBanner.textContent = msg;
        alertBanner.classList.add("show");
        alertBanner.hidden = false;
        setTimeout(() => { alertBanner.classList.remove("show"); }, 4000);
    }

    function logEvent(msg) {
        logs.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if(logs.length > 20) logs.pop();
        logList.innerHTML = logs.map(l => `<li class="log-item">${l}</li>`).join("");
    }

    function triggerBeep() {
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }

    // Initialize Map on load
    if (typeof L !== "undefined") {
        setTimeout(renderMap, 500);
    }

})();
