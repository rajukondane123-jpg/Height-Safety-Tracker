/**
 * ============================================================================
 * ALTIGUARD KERNEL - ENTERPRISE CLIENT ENGINE (SCRIPT.JS)
 * ============================================================================
 */

(function () {
    "use strict";

    const Utils = {
        escapeHtml: (str) => {
            if (!str) return "";
            return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        },
        niceStep: (maxVal) => { 
            const rough = maxVal / 4; 
            const mag = Math.pow(10, Math.floor(Math.log10(rough || 1))); 
            const norm = rough / mag; 
            return norm < 1.5 ? 1 * mag : norm < 3 ? 2 * mag : norm < 7 ? 5 * mag : 10 * mag; 
        },
        calculateDistance: (lat1, lon1, lat2, lon2) => {
            const R = 6371e3; // Earth radius in meters
            const p1 = lat1 * Math.PI/180;
            const p2 = lat2 * Math.PI/180;
            const dp = (lat2-lat1) * Math.PI/180;
            const dl = (lon2-lon1) * Math.PI/180;
            const a = Math.sin(dp/2) * Math.sin(dp/2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) * Math.sin(dl/2);
            return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
        }
    };

    const socket = io();
    
    const STATE = {
        role: "worker", 
        groupCode: null,
        mySelfId: null,
        liveTrackingId: null,
        gpsWatchId: null,
        globalBaseline: 0,
        geofenceRadius: 500,
        group: [],
        logs: [],
        kinematicHistory: [],
        mapInstance: null,
        mapMarkers: {},
        geofenceCircle: null,
        hospitalLayer: null,
        pendingLocation: null,
        isManualMode: false,
        baroSensor: null,
        baroBaseline: null,
        audioCtx: null
    };

    const CONFIG = {
        STORAGE_KEY: "altiguard_v5_settings",
        DEFAULT_LIMIT: 2.0,
        DEFAULT_DROP: 1.5,
        DEFAULT_WINDOW: 4,
        DEFAULT_FLOOR: 3.5,
        DEFAULT_NTFY: ""
    };

    let localSettings = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)) || { ...CONFIG };

    const DOM = {
        statRole: document.getElementById("statRole"),
        statActive: document.getElementById("statActive"),
        rosterList: document.getElementById("rosterList"),
        graphSvg: document.getElementById("graphSvg"),
        alertBanner: document.getElementById("alertBanner"),
        logList: document.getElementById("logList"),
        ntfyTopicInput: document.getElementById("ntfyTopicInput"),
        geofenceRadiusInput: document.getElementById("geofenceRadiusInput"),
        emptyHint: document.getElementById("emptyHint"),
        manualFields: document.getElementById("manualFields"),
        gpsReadout: document.getElementById("gpsReadout"),
        limitInput: document.getElementById("limitInput"),
        dropInput: document.getElementById("dropInput"),
        windowInput: document.getElementById("windowInput"),
        floorInput: document.getElementById("floorInput"),
        referenceInput: document.getElementById("referenceInput"),
        setRefBtn: document.getElementById("setRefBtn")
    };

    function triggerSiren() {
        if (navigator.vibrate) try { navigator.vibrate([200, 100, 200, 100, 400]); } catch (e) {}
        try {
            STATE.audioCtx = STATE.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (STATE.audioCtx.state === "suspended") STATE.audioCtx.resume();
            const pattern = [[880, 0.15], [0, 0.05], [660, 0.15], [0, 0.05], [880, 0.28]];
            let t = STATE.audioCtx.currentTime;
            pattern.forEach(([freq, dur]) => {
                if (freq > 0) {
                    const osc = STATE.audioCtx.createOscillator();
                    const gain = STATE.audioCtx.createGain();
                    osc.type = "square"; osc.frequency.value = freq;
                    gain.gain.setValueAtTime(0, t);
                    gain.gain.linearRampToValueAtTime(0.3, t + 0.02);
                    gain.gain.linearRampToValueAtTime(0, t + dur);
                    osc.connect(gain).connect(STATE.audioCtx.destination);
                    osc.start(t); osc.stop(t + dur + 0.05);
                }
                t += dur;
            });
        } catch (e) {}
    }

    socket.on('roleAssigned', (data) => {
        STATE.role = data.role; STATE.groupCode = data.groupCode;
        if(DOM.statRole) DOM.statRole.textContent = STATE.role.toUpperCase();
        
        const isPrivileged = (STATE.role === 'admin' || STATE.role === 'creator');
        if (DOM.ntfyTopicInput) DOM.ntfyTopicInput.disabled = !isPrivileged;
        if (DOM.geofenceRadiusInput) DOM.geofenceRadiusInput.disabled = !isPrivileged;
        [DOM.referenceInput, DOM.setRefBtn, DOM.limitInput, DOM.dropInput, DOM.windowInput, DOM.floorInput].forEach(el => {
            if(el) el.disabled = !isPrivileged;
        });

        // Ensure Admin pushes their local topic to the server immediately
        if (isPrivileged && DOM.ntfyTopicInput && DOM.ntfyTopicInput.value) {
            socket.emit('updateNtfyTopic', DOM.ntfyTopicInput.value.trim());
        }

        showAlert(`Uplink Established: ${STATE.groupCode} [${STATE.role.toUpperCase()}]`);
        renderUI();
    });

    socket.on('syncGroup', (members) => { STATE.group = members; renderUI(); });
    socket.on('syncBaseline', (baseline) => { STATE.globalBaseline = baseline; if(DOM.referenceInput) DOM.referenceInput.value = baseline; renderUI(); });
    socket.on('syncGeofence', (radius) => { STATE.geofenceRadius = radius; if(DOM.geofenceRadiusInput) DOM.geofenceRadiusInput.value = radius; renderMap(); });
    socket.on('syncNtfyTopic', (topic) => { if(DOM.ntfyTopicInput) DOM.ntfyTopicInput.value = topic; });

    socket.on('receiveAlert', (data) => { showAlert(`⚠️ FALL DETECTED: ${data.name} (${data.drop}m)`); logEvent(`⚠️ Fall: ${data.name} (${data.drop}m)`); triggerSiren(); });
    socket.on('receiveSOS', (payload) => { showAlert(`🚨 SOS PANIC: ${payload.name}`); logEvent(`🚨 SOS: ${payload.name}`); triggerSiren(); });

    // PERFECTED NTFY CLIENT (Bypasses CORS via URL Parameters)
    function transmitNtfyAlert(title, message, tags, lat, lon) {
        try { if (window.Notification && Notification.permission === "granted") new Notification(title, { body: message }); } catch(e){}

        const topic = (DOM.ntfyTopicInput && DOM.ntfyTopicInput.value.trim()) || localSettings.ntfyTopic;
        if (!topic) return; 
        
        const cleanTopic = topic.replace(/[^a-zA-Z0-9-_]/g, "");
        let ntfyUrl = `https://ntfy.sh/${cleanTopic}?title=${encodeURIComponent(title)}&priority=urgent&tags=${encodeURIComponent(tags)}`;
        if (lat && lon) ntfyUrl += `&click=${encodeURIComponent(`https://www.google.com/maps?q=${lat},${lon}`)}`;

        fetch(ntfyUrl, { method: 'POST', body: message })
            .then(res => { if(res.ok) logEvent(`✅ Ntfy Push Sent: ${title}`); else logEvent(`❌ Ntfy Server Error: ${res.status}`); })
            .catch(err => logEvent(`❌ Ntfy Blocked by Browser. Server-side will handle it.`));
    }

    document.getElementById("createGroupBtn").addEventListener("click", () => { const input = document.getElementById("groupCodeInput"); if(input) socket.emit('createGroup', input.value); });
    document.getElementById("joinGroupActionBtn").addEventListener("click", () => { const input = document.getElementById("groupCodeInput"); if(input && input.value) socket.emit('joinGroup', input.value); else showAlert("Enter a Site Code."); });

    if(DOM.setRefBtn) DOM.setRefBtn.addEventListener("click", () => {
        if (STATE.role !== 'admin' && STATE.role !== 'creator') return showAlert("Access Denied.");
        const val = parseFloat(DOM.referenceInput.value) || 0;
        STATE.globalBaseline = val; socket.emit('setBaseline', val); renderUI(); showAlert(`Datum Zero calibrated to ${val}m`);
    });

    document.getElementById("manualToggle").addEventListener("click", () => {
        STATE.isManualMode = !STATE.isManualMode;
        if(DOM.manualFields) DOM.manualFields.hidden = !STATE.isManualMode;
        if(DOM.gpsReadout) DOM.gpsReadout.hidden = true;
        const btn = document.getElementById("addBtn"); if(btn) btn.disabled = false;
    });

    document.getElementById("captureBtn").addEventListener("click", () => {
        triggerSiren(); // Unlock Audio
        if(DOM.gpsReadout) { DOM.gpsReadout.hidden = false; DOM.gpsReadout.innerHTML = `Acquiring Satellite Lock...`; }
        navigator.geolocation.getCurrentPosition((pos) => {
            STATE.pendingLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude, height: pos.coords.altitude || 0 };
            if(DOM.gpsReadout) DOM.gpsReadout.innerHTML = `<strong style="color:var(--brand-primary);">📍 Lock Acquired</strong><br>Coord: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
            const btn = document.getElementById("addBtn"); if(btn) btn.disabled = false; 
            STATE.isManualMode = false; if(DOM.manualFields) DOM.manualFields.hidden = true;
        }, (err) => { if(DOM.gpsReadout) DOM.gpsReadout.innerHTML = `❌ GPS Error: ${err.message}`; }, { enableHighAccuracy: true });
    });

    document.getElementById("addForm").addEventListener("submit", (e) => {
        e.preventDefault();
        if (!STATE.groupCode) return showAlert("⚠️ Create or Join a group first!");

        const name = document.getElementById("nameInput") ? document.getElementById("nameInput").value.trim() : "";
        const designation = document.getElementById("designationInput") ? document.getElementById("designationInput").value.trim() : "";
        if (!name || !designation) return;
        if (!STATE.mySelfId) STATE.mySelfId = "OP-" + Math.random().toString(36).slice(2, 10).toUpperCase();
        
        let pLat = null, pLon = null, pHeight = 0;
        if (STATE.isManualMode) {
            pHeight = document.getElementById("manualHeight") ? parseFloat(document.getElementById("manualHeight").value) || 0 : 0;
            pLat = document.getElementById("manualLat") ? parseFloat(document.getElementById("manualLat").value) || null : null;
            pLon = document.getElementById("manualLon") ? parseFloat(document.getElementById("manualLon").value) || null : null;
            if (pLat !== null && pLon !== null && STATE.mapInstance) STATE.mapInstance.flyTo([pLat, pLon], 16);
        } else if (STATE.pendingLocation) {
            pLat = STATE.pendingLocation.lat; pLon = STATE.pendingLocation.lon; pHeight = STATE.pendingLocation.height;
            if (STATE.mapInstance) STATE.mapInstance.flyTo([pLat, pLon], 18);
        }

        // CRITICAL FIX: Save the user's role so we know who the Admin is!
        const person = { id: STATE.mySelfId, name: name, designation: designation, role: STATE.role, height: pHeight, lat: pLat, lon: pLon, method: STATE.isManualMode ? "manual" : "auto" };

        const existingIndex = STATE.group.findIndex(p => p.id === STATE.mySelfId);
        if (existingIndex > -1) STATE.group[existingIndex] = person;
        else STATE.group.push(person);

        socket.emit('updateGroupData', STATE.group);
        if (!STATE.isManualMode) startTracking(STATE.mySelfId);
        
        document.getElementById("nameInput").value = ""; document.getElementById("designationInput").value = "";
        renderUI(); showAlert(`✅ ${name} injected.`);
    });

    const saveSettings = () => { 
        if(DOM.limitInput) localSettings.limit = parseFloat(DOM.limitInput.value) || CONFIG.DEFAULT_LIMIT; 
        if(DOM.dropInput) localSettings.dropThreshold = parseFloat(DOM.dropInput.value) || CONFIG.DEFAULT_DROP; 
        if(DOM.windowInput) localSettings.dropWindow = parseInt(DOM.windowInput.value, 10) || CONFIG.DEFAULT_WINDOW; 
        if(DOM.floorInput) localSettings.floorHeight = parseFloat(DOM.floorInput.value) || CONFIG.DEFAULT_FLOOR;
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(localSettings)); 
        
        if (DOM.geofenceRadiusInput && (STATE.role === 'admin' || STATE.role === 'creator')) {
            const rad = parseFloat(DOM.geofenceRadiusInput.value) || 500;
            socket.emit('updateGeofenceRadius', rad);
        }
        if (DOM.ntfyTopicInput && (STATE.role === 'admin' || STATE.role === 'creator')) {
            socket.emit('updateNtfyTopic', DOM.ntfyTopicInput.value.trim());
        }
        renderUI(); 
    };
    
    [DOM.limitInput, DOM.dropInput, DOM.windowInput, DOM.ntfyTopicInput, DOM.floorInput, DOM.geofenceRadiusInput].forEach(el => { 
        if(el) el.addEventListener("input", saveSettings); 
    });

    document.getElementById("testAlertBtn").addEventListener("click", () => {
        socket.emit('triggerFallAlert', { name: "System Diagnostic", drop: 1.5, id: "test" }); 
        showAlert(`⚠️ TEST SIREN INITIATED`); logEvent("Test alert broadcasted."); triggerSiren();
        transmitNtfyAlert("⚠️ TEST SIREN", "A diagnostic test siren has been activated by Command.", "loudspeaker");
    });

    document.getElementById("sosTriggerBtn").addEventListener("click", () => {
        if (!STATE.mySelfId) return showAlert("Matrix Error: Inject into the grid to use SOS.");
        const me = STATE.group.find(p => p.id === STATE.mySelfId);
        if(me) {
            socket.emit('triggerSOS', { name: me.name, lat: me.lat, lon: me.lon, height: me.height });
            triggerSiren();
            transmitNtfyAlert(`🚨 SOS INITIATED: ${me.name}`, `${me.name} triggered SOS panic protocol!`, "sos,rotating_light", me.lat, me.lon);
        }
    });

    window.toggleTrack = function(id) { if (STATE.liveTrackingId === id) stopTracking(); else startTracking(id); };
    window.removeNode = function(id) { if (STATE.liveTrackingId === id) stopTracking(); socket.emit('removePerson', id); };

    function startTracking(personId) {
        if (!navigator.geolocation) return showAlert("Geolocation disabled.");
        stopTracking(); triggerSiren(); STATE.liveTrackingId = personId; renderUI(); 

        STATE.gpsWatchId = navigator.geolocation.watchPosition((pos) => {
            const person = STATE.group.find(p => p.id === STATE.liveTrackingId);
            if (person) {
                person.lat = pos.coords.latitude; person.lon = pos.coords.longitude;
                if (pos.coords.altitude !== null) person.height = pos.coords.altitude;
                
                checkGeofenceBreach(person);
                checkKinematicDrop(person); 
                socket.emit('updateGroupData', STATE.group); 
                renderUI();
            }
        }, (err) => { showAlert(`GPS Interruption: ${err.message}`); }, { enableHighAccuracy: true, maximumAge: 0 });
    }

    function stopTracking() {
        if (STATE.gpsWatchId) navigator.geolocation.clearWatch(STATE.gpsWatchId);
        STATE.liveTrackingId = null; STATE.gpsWatchId = null; renderUI();
    }

    // PERFECTED GEOFENCE LOGIC (Targeting Admin Location)
    function checkGeofenceBreach(person) {
        if (STATE.group.length === 0 || person.lat === null || person.lon === null) return;
        
        // Specifically look for the Admin's Location to act as the center
        const adminNode = STATE.group.find(p => p.role === 'admin' || p.role === 'creator');
        
        if (adminNode && adminNode.lat && adminNode.lon && adminNode.id !== person.id) {
            const dist = Utils.calculateDistance(adminNode.lat, adminNode.lon, person.lat, person.lon);
            if (dist > STATE.geofenceRadius) {
                // Anti-Spam: Only alert once every 15 seconds
                if (!person.lastGeoAlert || Date.now() - person.lastGeoAlert > 15000) {
                    showAlert(`🚨 GEOFENCE BREACH: ${person.name} is ${Math.round(dist)}m away from Command!`);
                    triggerSiren();
                    transmitNtfyAlert(`🚨 GEOFENCE BREACH: ${person.name}`, `${person.name} is ${Math.round(dist)}m outside the safe zone!`, "warning,world_map", person.lat, person.lon);
                    person.lastGeoAlert = Date.now();
                }
            }
        }
    }

    function checkKinematicDrop(person) {
        const now = Date.now();
        const limit = DOM.dropInput ? parseFloat(DOM.dropInput.value) || CONFIG.DEFAULT_DROP : CONFIG.DEFAULT_DROP;
        const windowSec = DOM.windowInput ? parseInt(DOM.windowInput.value) || CONFIG.DEFAULT_WINDOW : CONFIG.DEFAULT_WINDOW;
        
        STATE.kinematicHistory.push({ time: now, h: person.height });
        STATE.kinematicHistory = STATE.kinematicHistory.filter(e => now - e.time <= windowSec * 1000);
        
        if (STATE.kinematicHistory.length >= 2) {
            const peak = Math.max(...STATE.kinematicHistory.map(e => e.h));
            if (peak - person.height >= limit) {
                const dropAmt = (peak - person.height).toFixed(2);
                socket.emit('triggerFallAlert', { name: person.name, drop: dropAmt, id: person.id, lat: person.lat, lon: person.lon });
                triggerSiren(); 
                transmitNtfyAlert(`🚨 FALL ALERT: ${person.name}`, `${person.name} dropped ${dropAmt}m!`, "rotating_light,skull", person.lat, person.lon);
                STATE.kinematicHistory = []; 
            }
        }
    }

    function renderUI() {
        if(DOM.statActive) DOM.statActive.textContent = `${STATE.group.length} Tracked`;
        if (STATE.group.length === 0) { 
            if(DOM.emptyHint) DOM.emptyHint.style.display = "flex"; 
            if(DOM.rosterList) DOM.rosterList.innerHTML = ""; 
            if(DOM.graphSvg) DOM.graphSvg.innerHTML = ""; 
        } 
        else { 
            if(DOM.emptyHint) DOM.emptyHint.style.display = "none"; 
            renderRoster(); renderGraph(); 
        }
        renderMap();
    }

    function renderRoster() {
        if(!DOM.rosterList) return;
        DOM.rosterList.innerHTML = STATE.group.map(p => {
            const relHeight = p.height - STATE.globalBaseline;
            const limit = DOM.limitInput ? parseFloat(DOM.limitInput.value) || CONFIG.DEFAULT_LIMIT : CONFIG.DEFAULT_LIMIT;
            const statusClass = relHeight > limit ? "status-above" : relHeight < -limit ? "status-below" : "status-within";
            const isLive = p.id === STATE.liveTrackingId;
            const isMe = p.id === STATE.mySelfId;
            
            let actionBtns = "";
            if (STATE.role === "admin" || STATE.role === "creator" || isMe) {
                actionBtns += `<button class="mini-btn remove-btn" onclick="removeNode('${p.id}')">✕ Eject</button>`;
            }
            if (isMe) {
                actionBtns += `<button class="mini-btn track-btn ${isLive ? 'active' : ''}" onclick="toggleTrack('${p.id}')">${isLive ? "⏹ Halt GPS" : "📍 Track GPS"}</button>`;
            }

            return `
                <li class="roster-item ${isLive ? 'is-live' : ''}">
                    <div class="roster-info">
                        <strong>${(p.role === 'admin' || p.role === 'creator') ? '👑 ' : ''}${Utils.escapeHtml(p.name)}</strong>
                        <span class="roster-sub">${Utils.escapeHtml(p.designation)} <br> Raw Z: ${p.height.toFixed(2)}m</span>
                    </div>
                    <div class="roster-status ${statusClass}">${(relHeight >= 0 ? "+" : "")}${relHeight.toFixed(2)}m</div>
                    <div class="roster-actions">${actionBtns}</div>
                </li>
            `;
        }).join('');
    }

    function renderGraph() {
        if(!DOM.graphSvg) return;
        const W = DOM.graphSvg.clientWidth || 1000; const H = DOM.graphSvg.clientHeight || 600; 
        const paddingLeft = 60; const paddingRight = 40; const paddingTopBottom = 60;
        const limit = DOM.limitInput ? parseFloat(DOM.limitInput.value) || CONFIG.DEFAULT_LIMIT : CONFIG.DEFAULT_LIMIT;
        const floorH = DOM.floorInput ? parseFloat(DOM.floorInput.value) || CONFIG.DEFAULT_FLOOR : CONFIG.DEFAULT_FLOOR;
        const rels = STATE.group.map(p => p.height - STATE.globalBaseline);
        const maxAbs = Math.max(limit * 1.5, ...rels.map(Math.abs), 1);
        const plotHeight = H - (paddingTopBottom * 2);
        const scaleY = (plotHeight / 2) / maxAbs; const midY = H / 2;

        let svgHtml = "";
        const usableWidth = W - paddingLeft - paddingRight;

        const floorPx = floorH * scaleY;
        const startFloor = Math.floor(-maxAbs / floorH) - 1;
        const endFloor = Math.ceil(maxAbs / floorH) + 1;

        for (let f = startFloor; f <= endFloor; f++) {
            const yBot = midY - (f * floorH) * scaleY;
            const yTop = yBot - floorPx;
            const rectBot = Math.min(Math.max(yBot, paddingTopBottom), H - paddingTopBottom);
            const rectTop = Math.max(Math.min(yTop, H - paddingTopBottom), paddingTopBottom);
            const rectHeight = rectBot - rectTop;

            if (rectHeight > 0) {
                const fillClass = Math.abs(f) % 2 === 0 ? 'floor-even' : 'floor-odd';
                svgHtml += `<rect x="${paddingLeft}" y="${rectTop}" width="${usableWidth}" height="${rectHeight}" class="${fillClass}"></rect>`;
                if (rectHeight > 15) {
                    const labelStr = f >= 0 ? `Lvl ${f}` : `Bsmnt ${Math.abs(f)}`;
                    svgHtml += `<text x="${W - paddingRight - 10}" y="${rectTop + 16}" fill="rgba(0,240,255,0.4)" font-size="10" font-family="monospace" text-anchor="end">${labelStr}</text>`;
                }
            }
        }

        const step = Utils.niceStep(maxAbs);
        for (let v = step; v <= maxAbs; v += step) {
            [v, -v].forEach(val => {
                const y = midY - (val * scaleY);
                if (y >= paddingTopBottom && y <= H - paddingTopBottom) {
                    svgHtml += `<line class="grid-line" x1="${paddingLeft}" y1="${y}" x2="${W - paddingRight}" y2="${y}"></line>`;
                    svgHtml += `<text class="axis-label" x="${paddingLeft - 10}" y="${y + 4}" text-anchor="end" font-weight="bold">${(val > 0 ? '+' : '')}${val}m</text>`;
                }
            });
        }

        svgHtml += `<line class="baseline" x1="${paddingLeft}" y1="${midY}" x2="${W - paddingRight}" y2="${midY}"></line>`;
        svgHtml += `<text class="axis-label" x="${paddingLeft - 10}" y="${midY + 4}" fill="#00f0ff" font-weight="bold" text-anchor="end">0m</text>`;
        svgHtml += `<text class="axis-label" x="${W - paddingRight}" y="${midY - 10}" fill="#00f0ff" text-anchor="end">DATUM ZERO</text>`;

        STATE.group.forEach((p, i) => {
            const rel = p.height - STATE.globalBaseline;
            const x = paddingLeft + (usableWidth * (i + 0.5)) / STATE.group.length;
            const y = midY - (rel * scaleY);
            const status = rel > limit ? "above" : rel < -limit ? "below" : "within";

            svgHtml += `
                <g class="figure figure-${status}" style="transform: translate(${x}px, ${y}px)">
                    ${p.id === STATE.liveTrackingId ? '<circle class="live-halo" r="30" cy="-10"></circle>' : ''}
                    <text class="figure-readout" x="0" y="-55" text-anchor="middle">${(rel >= 0 ? "+" : "")}${rel.toFixed(2)}m</text>
                    <circle class="figure-head" cx="0" cy="-30" r="10"></circle>
                    <line class="figure-body" x1="0" y1="-20" x2="0" y2="10"></line>
                    <line class="figure-arm" x1="0" y1="-15" x2="-15" y2="-5"></line>
                    <line class="figure-arm" x1="0" y1="-15" x2="15" y2="-5"></line>
                    <line class="figure-leg" x1="0" y1="10" x2="-12" y2="30"></line>
                    <line class="figure-leg" x1="0" y1="10" x2="12" y2="30"></line>
                    <text class="figure-label" x="0" y="55" text-anchor="middle">${Utils.escapeHtml(p.name)}</text>
                    <text class="figure-label-sub" x="0" y="70" text-anchor="middle">${Utils.escapeHtml(p.designation)}</text>
                </g>
            `;
        });
        DOM.graphSvg.innerHTML = svgHtml;
    }

    function renderMap() {
        if (!STATE.mapInstance && typeof L !== "undefined") {
            STATE.mapInstance = L.map('map').setView([20.5937, 78.9629], 5);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(STATE.mapInstance);
        }
        if (!STATE.mapInstance) return;

        // Render Geofence Circle on Map dynamically centered on Admin
        const adminNode = STATE.group.find(p => p.role === 'admin' || p.role === 'creator');
        if (adminNode && adminNode.lat !== null && adminNode.lon !== null) {
            const centerLatLng = [adminNode.lat, adminNode.lon];
            if (STATE.geofenceCircle) {
                STATE.geofenceCircle.setLatLng(centerLatLng);
                STATE.geofenceCircle.setRadius(STATE.geofenceRadius);
            } else {
                STATE.geofenceCircle = L.circle(centerLatLng, {
                    color: '#ff0055', // Red Cyber Perimeter
                    fillColor: '#ff0055',
                    fillOpacity: 0.1,
                    radius: STATE.geofenceRadius,
                    weight: 2,
                    dashArray: '5, 5'
                }).addTo(STATE.mapInstance);
            }
        } else if (STATE.geofenceCircle) {
            // Remove circle if admin leaves
            STATE.mapInstance.removeLayer(STATE.geofenceCircle);
            STATE.geofenceCircle = null;
        }

        const currentIds = STATE.group.map(p => p.id);
        for (let id in STATE.mapMarkers) {
            if (!currentIds.includes(id)) { STATE.mapInstance.removeLayer(STATE.mapMarkers[id]); delete STATE.mapMarkers[id]; }
        }

        STATE.group.forEach(p => {
            if (p.lat !== null && p.lon !== null) {
                if (STATE.mapMarkers[p.id]) { STATE.mapMarkers[p.id].setLatLng([p.lat, p.lon]); } 
                else {
                    const isAdmin = (p.role === 'admin' || p.role === 'creator');
                    const iconHtml = `<svg width="30" height="30" viewBox="0 0 24 24" fill="${isAdmin ? '#ff0055' : (p.id === STATE.liveTrackingId ? '#ffb800' : '#00f0ff')}"><circle cx="12" cy="12" r="10" stroke="#fff" stroke-width="2"/></svg>`;
                    const divIcon = L.divIcon({ className: 'tactical-marker', html: iconHtml, iconSize: [30,30] });
                    STATE.mapMarkers[p.id] = L.marker([p.lat, p.lon], { icon: divIcon }).addTo(STATE.mapInstance).bindPopup(`<b>${isAdmin ? '👑 ' : ''}${Utils.escapeHtml(p.name)}</b><br>${Utils.escapeHtml(p.designation)}<br>Lat: ${p.lat.toFixed(5)}<br>Lon: ${p.lon.toFixed(5)}`);
                }
            }
        });
    }

    function loadSettings() { try { return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)) || { ...CONFIG }; } catch (e) { return { ...CONFIG }; } }
    function showAlert(msg) { if(!DOM.alertBanner) return; DOM.alertBanner.textContent = msg; DOM.alertBanner.classList.add("show"); DOM.alertBanner.hidden = false; setTimeout(() => DOM.alertBanner.classList.remove("show"), 5000); }
    function logEvent(msg) { STATE.logs.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`); if(STATE.logs.length > 30) STATE.logs.pop(); if(DOM.logList) DOM.logList.innerHTML = STATE.logs.map(l => `<li class="log-item">${l}</li>`).join(""); }

    if (typeof L !== "undefined") setTimeout(renderMap, 500);
    
    // Auto-ask for push permission so Ntfy can work natively in browser
    try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch(e){}

    if(DOM.limitInput) DOM.limitInput.value = localSettings.limit; 
    if(DOM.dropInput) DOM.dropInput.value = localSettings.dropThreshold; 
    if(DOM.windowInput) DOM.windowInput.value = localSettings.dropWindow; 
    if(DOM.floorInput) DOM.floorInput.value = localSettings.floorHeight;
    if(DOM.ntfyTopicInput) DOM.ntfyTopicInput.value = localSettings.ntfyTopic;
    if(DOM.geofenceRadiusInput) DOM.geofenceRadiusInput.value = localSettings.geofenceRadius;

})();
