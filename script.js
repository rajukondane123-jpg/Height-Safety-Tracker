/**
 * ============================================================================
 * ALTIGUARD KERNEL - ENTERPRISE CLIENT ENGINE (SCRIPT.JS)
 * ============================================================================
 */

(function () {
    "use strict";

    // ========================================================================
    // 1. SYSTEM STATE & MEMORY CONFIGURATION
    // ========================================================================
    const socket = io();
    
    const STATE = {
        role: "worker", 
        groupCode: null,
        mySelfId: null,
        liveTrackingId: null,
        gpsWatchId: null,
        globalBaseline: 0,
        group: [],
        logs: [],
        kinematicHistory: [],
        mapInstance: null,
        mapMarkers: {},
        pendingLocation: null,
        isManualMode: false
    };

    const CONFIG = {
        STORAGE_KEY: "altiguard_v5_settings",
        DEFAULT_LIMIT: 2.0,
        DEFAULT_DROP: 1.5,
        DEFAULT_WINDOW: 4,
        DEFAULT_NTFY: ""
    };

    let localSettings = loadSettings();

    const DOM = {
        statRole: document.getElementById("statRole"),
        statActive: document.getElementById("statActive"),
        rosterList: document.getElementById("rosterList"),
        graphSvg: document.getElementById("graphSvg"),
        alertBanner: document.getElementById("alertBanner"),
        logList: document.getElementById("logList"),
        ntfyTopicInput: document.getElementById("ntfyTopicInput"),
        emptyHint: document.getElementById("emptyHint"),
        manualFields: document.getElementById("manualFields"),
        gpsReadout: document.getElementById("gpsReadout")
    };


    // ========================================================================
    // 2. CORE SOCKET.IO NETWORK LISTENERS
    // ========================================================================
    socket.on('roleAssigned', (data) => {
        STATE.role = data.role; 
        STATE.groupCode = data.groupCode;
        
        DOM.statRole.textContent = STATE.role.toUpperCase();
        document.getElementById("groupCodeInput").value = STATE.groupCode;
        
        if (STATE.role === 'admin' || STATE.role === 'creator') {
            DOM.ntfyTopicInput.disabled = false;
            DOM.ntfyTopicInput.placeholder = "Enter Ntfy Topic (e.g. altiguard-site-99)";
        } else {
            DOM.ntfyTopicInput.disabled = true;
            DOM.ntfyTopicInput.placeholder = "Locked: Admin Clearance Required";
        }

        showAlert(`Uplink Established: Connected to ${STATE.groupCode} as ${STATE.role.toUpperCase()}`);
        renderUI();
    });

    socket.on('syncGroup', (members) => { STATE.group = members; renderUI(); });
    socket.on('syncBaseline', (baseline) => { STATE.globalBaseline = baseline; document.getElementById("referenceInput").value = baseline; renderUI(); });

    socket.on('receiveAlert', (data) => { 
        showAlert(`⚠️ KINEMATIC ALERT: ${data.name} dropped ${data.drop}m!`); 
        logEvent(`⚠️ Fall detected: ${data.name} (${data.drop}m)`); 
        triggerHaptics();
        transmitNtfyAlert(`🚨 FALL ALERT: ${data.name}`, `${data.name} has experienced a sudden drop of ${data.drop}m. Verify safety immediately!`, "rotating_light,skull");
    });

    socket.on('receiveSOS', (payload) => { 
        showAlert(`🚨 SOS PANIC: ${payload.name} requested extraction!`); 
        logEvent(`🚨 SOS Activated by ${payload.name}`); 
        triggerHaptics();
        transmitNtfyAlert(`🚨 SOS INITIATED: ${payload.name}`, `${payload.name} has triggered the emergency SOS panic protocol at Z: ${payload.height.toFixed(2)}m.`, "sos,rotating_light");
    });


    // ========================================================================
    // 3. NTFY.SH PUSH NOTIFICATION ENGINE
    // ========================================================================
    function transmitNtfyAlert(title, message, tags) {
        const topic = DOM.ntfyTopicInput.value.trim() || localSettings.ntfyTopic;
        if (!topic) return; 
        const cleanTopic = topic.replace(/[^a-zA-Z0-9-_]/g, "");
        fetch(`https://ntfy.sh/${cleanTopic}`, { method: 'POST', body: message, headers: { 'Title': title, 'Priority': 'urgent', 'Tags': tags } }).catch(err => console.warn("[REST_ERR] Ntfy Push Failed.", err));
    }


    // ========================================================================
    // 4. METEOROLOGY & REVERSE GEOCODING
    // ========================================================================
    async function fetchWeatherAndAQI(lat, lon) {
        try {
            const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
            const weatherData = await weatherRes.json();
            const aqiRes = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=european_aqi`);
            const aqiData = await aqiRes.json();

            const temp = weatherData.current_weather.temperature;
            const wind = weatherData.current_weather.windspeed;
            const code = weatherData.current_weather.weathercode;
            const aqi = aqiData.current.european_aqi;

            document.getElementById("wTemp").innerText = `${temp}°C`;
            document.getElementById("wWind").innerText = `${wind} km/h`;
            
            const aqiEl = document.getElementById("wAqi");
            aqiEl.innerText = aqi;
            aqiEl.className = "aqi-badge";
            if (aqi < 40) aqiEl.classList.add("aqi-good");
            else if (aqi < 80) aqiEl.classList.add("aqi-mod");
            else aqiEl.classList.add("aqi-poor");

            const iconBox = document.getElementById("weatherIconBox");
            const conditionEl = document.getElementById("wCondition");
            
            if (code === 0 || code === 1) { conditionEl.innerText = "Clear & Sunny"; iconBox.innerHTML = `<div class="anim-sun"></div>`; } 
            else if (code >= 51 && code <= 67) { conditionEl.innerText = "Rain Precipitation"; iconBox.innerHTML = `<div class="anim-cloud anim-rain"></div>`; } 
            else { conditionEl.innerText = "Cloudy / Overcast"; iconBox.innerHTML = `<div class="anim-cloud"></div>`; }
        } catch (e) { console.error("[CLIMATE_ERR] Weather fetch failed", e); }
    }

    async function fetchAddress(lat, lon) {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`);
            const data = await res.json();
            if (data && data.address) { const addr = data.address; return `${addr.road || addr.suburb || ''}, ${addr.city || addr.town || addr.county || ''} - ${addr.postcode || ''}`; }
            return "Coordinates locked. Address unavailable.";
        } catch(e) { return "Coordinates locked. Address unavailable."; }
    }


    // ========================================================================
    // 5. DOM INTERACTION & EVENT BINDINGS
    // ========================================================================
    document.getElementById("createGroupBtn").addEventListener("click", () => { socket.emit('createGroup', document.getElementById("groupCodeInput").value); });
    document.getElementById("joinGroupActionBtn").addEventListener("click", () => {
        const code = document.getElementById("groupCodeInput").value;
        if (!code) return showAlert("Matrix Error: Please enter a Site Code.");
        socket.emit('joinGroup', code);
    });

    document.getElementById("setRefBtn").addEventListener("click", () => {
        const val = parseFloat(document.getElementById("referenceInput").value) || 0;
        STATE.globalBaseline = val; socket.emit('setBaseline', val); renderUI(); showAlert(`Datum Zero calibrated to ${val}m`); logEvent(`System Datum re-calibrated to ${val}m`);
    });

    document.getElementById("manualToggle").addEventListener("click", () => {
        STATE.isManualMode = !STATE.isManualMode;
        DOM.manualFields.hidden = !STATE.isManualMode;
        DOM.gpsReadout.hidden = true;
        document.getElementById("addBtn").disabled = false;
    });

    document.getElementById("captureBtn").addEventListener("click", () => {
        DOM.gpsReadout.hidden = false;
        DOM.gpsReadout.innerHTML = `<div class="spinner" style="width:15px;height:15px;display:inline-block;vertical-align:middle;margin-right:10px;"></div> Acquiring Satellite Lock...`;

        navigator.geolocation.getCurrentPosition(async (pos) => {
            const lat = pos.coords.latitude; const lon = pos.coords.longitude; const alt = pos.coords.altitude || 0;
            DOM.gpsReadout.innerHTML = `Fetching precise address & climate data...`;
            
            const [address] = await Promise.all([ fetchAddress(lat, lon), fetchWeatherAndAQI(lat, lon) ]);
            STATE.pendingLocation = { lat, lon, height: alt };

            DOM.gpsReadout.innerHTML = `<strong style="color:var(--brand-primary);">📍 Lock Acquired</strong><br><span style="font-family:monospace; color:#ccc;">Coord: ${lat.toFixed(5)}, ${lon.toFixed(5)}</span><br><span style="font-size:0.8rem; color:var(--text-muted);">${address}</span>`;
            document.getElementById("addBtn").disabled = false; STATE.isManualMode = false; DOM.manualFields.hidden = true;
        }, (err) => { DOM.gpsReadout.innerHTML = `<span style="color:var(--accent-danger);">❌ GPS Error: ${err.message}</span>`; }, { enableHighAccuracy: true });
    });

    // --- PATCHED INJECTION LOGIC ---
    document.getElementById("addForm").addEventListener("submit", (e) => {
        e.preventDefault();

        // 1. Strict Group Check
        if (!STATE.groupCode) {
            return showAlert("⚠️ Action Denied: You must Create or Join a group (Step 01) first!");
        }

        const name = document.getElementById("nameInput").value.trim();
        const designation = document.getElementById("designationInput").value.trim();
        if (!name || !designation) return;

        if (!STATE.mySelfId) STATE.mySelfId = "OP-" + Math.random().toString(36).slice(2, 10).toUpperCase();
        
        let pLat = null, pLon = null, pHeight = 0;

        if (STATE.isManualMode) {
            pHeight = parseFloat(document.getElementById("manualHeight").value) || 0;
            pLat = parseFloat(document.getElementById("manualLat").value) || null;
            pLon = parseFloat(document.getElementById("manualLon").value) || null;
            if (pLat !== null && pLon !== null) fetchWeatherAndAQI(pLat, pLon);
        } else if (STATE.pendingLocation) {
            pLat = STATE.pendingLocation.lat; pLon = STATE.pendingLocation.lon; pHeight = STATE.pendingLocation.height;
        }

        const person = { id: STATE.mySelfId, name: name, designation: designation, height: pHeight, lat: pLat, lon: pLon, method: STATE.isManualMode ? "manual" : "auto" };

        const existingIndex = STATE.group.findIndex(p => p.id === STATE.mySelfId);
        if (existingIndex > -1) STATE.group[existingIndex] = person;
        else STATE.group.push(person);

        socket.emit('updateGroupData', STATE.group);
        if (!STATE.isManualMode) startTracking(STATE.mySelfId);
        
        // 2. Clear Form & Visual Feedback
        document.getElementById("nameInput").value = "";
        document.getElementById("designationInput").value = "";
        
        if (!STATE.isManualMode) {
            DOM.gpsReadout.innerHTML = `<strong style="color:var(--accent-success);">✓ Sensor Link Established</strong>`;
            setTimeout(() => { DOM.gpsReadout.hidden = true; }, 3000);
        }
        
        const btn = document.getElementById("addBtn");
        btn.textContent = "✓ INJECTED";
        btn.style.background = "var(--accent-success)";
        btn.style.color = "#000";
        
        setTimeout(() => {
            btn.textContent = "+ Inject into Grid";
            btn.style.background = "";
            btn.style.color = "";
            btn.disabled = true; 
        }, 2000);

        renderUI();
        showAlert(`✅ ${name} successfully injected into the matrix.`);
    });

    const saveSettings = () => { 
        localSettings.limit = parseFloat(document.getElementById("limitInput").value) || CONFIG.DEFAULT_LIMIT; 
        localSettings.dropThreshold = parseFloat(document.getElementById("dropInput").value) || CONFIG.DEFAULT_DROP; 
        localSettings.dropWindow = parseInt(document.getElementById("windowInput").value, 10) || CONFIG.DEFAULT_WINDOW; 
        localSettings.ntfyTopic = DOM.ntfyTopicInput.value.trim() || ""; 
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(localSettings)); renderUI(); 
    };
    ["limitInput", "dropInput", "windowInput", "ntfyTopicInput"].forEach(id => { document.getElementById(id).addEventListener("input", saveSettings); });


    // ========================================================================
    // 6. EMERGENCY ACTIONS (SOS & ALERTS)
    // ========================================================================
    document.getElementById("testAlertBtn").addEventListener("click", () => {
        const testData = { name: "System Diagnostic", drop: 1.5, id: "test" };
        socket.emit('triggerFallAlert', testData); showAlert(`⚠️ TEST SIREN INITIATED`); logEvent("Test alert broadcasted."); transmitNtfyAlert("⚠️ TEST SIREN", "A diagnostic test siren has been activated by Command.", "loudspeaker");
    });

    document.getElementById("sosTriggerBtn").addEventListener("click", () => {
        if (!STATE.mySelfId) return showAlert("Matrix Error: You must inject into the grid to use SOS.");
        const me = STATE.group.find(p => p.id === STATE.mySelfId);
        socket.emit('triggerSOS', { name: me.name, lat: me.lat, lon: me.lon, height: me.height });
    });


    // ========================================================================
    // 7. KINEMATICS & LIVE TRACKING ENGINE
    // ========================================================================
    window.toggleTrack = function(id) { if (STATE.liveTrackingId === id) stopTracking(); else startTracking(id); };
    window.removeNode = function(id) { if (STATE.liveTrackingId === id) stopTracking(); socket.emit('removePerson', id); };

    function startTracking(personId) {
        if (!navigator.geolocation) return showAlert("Hardware Error: Geolocation disabled.");
        stopTracking(); STATE.liveTrackingId = personId; renderUI(); 

        STATE.gpsWatchId = navigator.geolocation.watchPosition((pos) => {
            const person = STATE.group.find(p => p.id === STATE.liveTrackingId);
            if (person) {
                person.lat = pos.coords.latitude; person.lon = pos.coords.longitude;
                if (pos.coords.altitude !== null) person.height = pos.coords.altitude;
                checkKinematicDrop(person); socket.emit('updateGroupData', STATE.group); renderUI();
            }
        }, (err) => { showAlert(`GPS Interruption: ${err.message}`); }, { enableHighAccuracy: true, maximumAge: 0 });
    }

    function stopTracking() {
        if (STATE.gpsWatchId) navigator.geolocation.clearWatch(STATE.gpsWatchId);
        STATE.liveTrackingId = null; STATE.gpsWatchId = null; renderUI();
    }

    function checkKinematicDrop(person) {
        const now = Date.now();
        const limit = parseFloat(document.getElementById("dropInput").value) || CONFIG.DEFAULT_DROP;
        const windowSec = parseInt(document.getElementById("windowInput").value) || CONFIG.DEFAULT_WINDOW;
        
        STATE.kinematicHistory.push({ time: now, h: person.height });
        STATE.kinematicHistory = STATE.kinematicHistory.filter(e => now - e.time <= windowSec * 1000);
        
        if (STATE.kinematicHistory.length >= 2) {
            const peak = Math.max(...STATE.kinematicHistory.map(e => e.h));
            if (peak - person.height >= limit) {
                const dropAmt = (peak - person.height).toFixed(2);
                socket.emit('triggerFallAlert', { name: person.name, drop: dropAmt, id: person.id });
                transmitNtfyAlert(`🚨 FALL ALERT: ${person.name}`, `${person.name} has experienced a sudden drop of ${dropAmt}m.`, "rotating_light,skull");
                STATE.kinematicHistory = []; 
            }
        }
    }


    // ========================================================================
    // 8. MASTER RENDER ENGINE
    // ========================================================================
    function renderUI() {
        DOM.statActive.textContent = `${STATE.group.length} Tracked`;
        if (STATE.group.length === 0) { DOM.emptyHint.style.display = "flex"; DOM.rosterList.innerHTML = ""; DOM.graphSvg.innerHTML = ""; } 
        else { DOM.emptyHint.style.display = "none"; renderRoster(); renderGraph(); }
        renderMap();
    }

    function renderRoster() {
        DOM.rosterList.innerHTML = STATE.group.map(p => {
            const relHeight = p.height - STATE.globalBaseline;
            const limit = parseFloat(document.getElementById("limitInput").value) || CONFIG.DEFAULT_LIMIT;
            const statusClass = relHeight > limit ? "status-above" : relHeight < -limit ? "status-below" : "status-within";
            const isLive = p.id === STATE.liveTrackingId;
            const isMe = p.id === STATE.mySelfId;
            
            let actionBtns = "";
            if (STATE.role === "admin" || STATE.role === "creator" || isMe) {
                actionBtns += `<button class="mini-btn remove-btn" onclick="removeNode('${p.id}')">✕ Eject</button>`;
                actionBtns += `<button class="mini-btn track-btn ${isLive ? 'active' : ''}" onclick="toggleTrack('${p.id}')">${isLive ? "⏹ Halt GPS" : "📍 Track GPS"}</button>`;
            }

            return `
                <li class="roster-item ${isLive ? 'is-live' : ''}">
                    <div class="roster-info">
                        <strong>${(STATE.role === 'admin' || STATE.role === 'creator') && p.id === STATE.group[0].id ? '👑 ' : ''}${Utils.escapeHtml(p.name)}</strong>
                        <span class="roster-sub">${Utils.escapeHtml(p.designation)} <br> Raw Z: ${p.height.toFixed(2)}m</span>
                    </div>
                    <div class="roster-status ${statusClass}">${(relHeight >= 0 ? "+" : "")}${relHeight.toFixed(2)}m</div>
                    <div class="roster-actions">${actionBtns}</div>
                </li>
            `;
        }).join('');
    }

    function renderGraph() {
        const W = DOM.graphSvg.clientWidth || 1000; const H = DOM.graphSvg.clientHeight || 600; 
        const paddingLeft = 60; const paddingRight = 40; const paddingTopBottom = 60;
        const limit = parseFloat(document.getElementById("limitInput").value) || CONFIG.DEFAULT_LIMIT;
        const rels = STATE.group.map(p => p.height - STATE.globalBaseline);
        const maxAbs = Math.max(limit * 1.5, ...rels.map(Math.abs), 1);
        const plotHeight = H - (paddingTopBottom * 2);
        const scaleY = (plotHeight / 2) / maxAbs; const midY = H / 2;

        let svgHtml = "";
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
        svgHtml += `<text class="axis-label" x="${paddingLeft - 10}" y="${midY + 4}" fill="#38bdf8" font-weight="bold" text-anchor="end">0m</text>`;
        svgHtml += `<text class="axis-label" x="${W - paddingRight}" y="${midY - 10}" fill="#38bdf8" text-anchor="end">DATUM ZERO</text>`;

        STATE.group.forEach((p, i) => {
            const rel = p.height - STATE.globalBaseline;
            const usableWidth = W - paddingLeft - paddingRight;
            const x = paddingLeft + (usableWidth * (i + 0.5)) / STATE.group.length;
            const y = midY - (rel * scaleY);
            const status = rel > limit ? "above" : rel < -limit ? "below" : "within";

            svgHtml += `
                <g class="figure figure-${status}" style="transform: translate(${x}px, ${y}px)">
                    ${p.id === STATE.liveTrackingId ? '<circle class="live-halo" r="30" cy="-10"></circle>' : ''}
                    <text class="figure-readout" x="0" y="-55" text-anchor="middle" font-size="16" font-weight="bold">${(rel >= 0 ? "+" : "")}${rel.toFixed(2)}m</text>
                    <circle class="figure-head" cx="0" cy="-30" r="10"></circle>
                    <line class="figure-body" x1="0" y1="-20" x2="0" y2="10"></line>
                    <line class="figure-arm" x1="0" y1="-15" x2="-15" y2="-5"></line>
                    <line class="figure-arm" x1="0" y1="-15" x2="15" y2="-5"></line>
                    <line class="figure-leg" x1="0" y1="10" x2="-12" y2="30"></line>
                    <line class="figure-leg" x1="0" y1="10" x2="12" y2="30"></line>
                    <text class="figure-label" x="0" y="55" text-anchor="middle" font-size="14" font-weight="bold" fill="#fff">${Utils.escapeHtml(p.name)}</text>
                    <text class="figure-label-sub" x="0" y="70" text-anchor="middle" font-size="11" fill="#94a3b8">${Utils.escapeHtml(p.designation)}</text>
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

        const currentIds = STATE.group.map(p => p.id);
        for (let id in STATE.mapMarkers) {
            if (!currentIds.includes(id)) { STATE.mapInstance.removeLayer(STATE.mapMarkers[id]); delete STATE.mapMarkers[id]; }
        }

        STATE.group.forEach(p => {
            if (p.lat !== null && p.lon !== null) {
                if (STATE.mapMarkers[p.id]) { STATE.mapMarkers[p.id].setLatLng([p.lat, p.lon]); } 
                else {
                    const iconHtml = `<svg width="30" height="30" viewBox="0 0 24 24" fill="${p.id === STATE.liveTrackingId ? '#f59e0b' : '#38bdf8'}"><circle cx="12" cy="12" r="10" stroke="#fff" stroke-width="2"/></svg>`;
                    const divIcon = L.divIcon({ className: 'tactical-marker', html: iconHtml, iconSize: [30,30] });
                    STATE.mapMarkers[p.id] = L.marker([p.lat, p.lon], { icon: divIcon }).addTo(STATE.mapInstance).bindPopup(`<b>${Utils.escapeHtml(p.name)}</b><br>${Utils.escapeHtml(p.designation)}<br>Lat: ${p.lat.toFixed(5)}<br>Lon: ${p.lon.toFixed(5)}`);
                }
            }
        });
    }

    // ========================================================================
    // 9. HELPER UTILITIES
    // ========================================================================
    function loadSettings() { try { return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)) || { ...CONFIG }; } catch (e) { return { ...CONFIG }; } }
    function showAlert(msg) { DOM.alertBanner.textContent = msg; DOM.alertBanner.classList.add("show"); DOM.alertBanner.hidden = false; setTimeout(() => DOM.alertBanner.classList.remove("show"), 5000); }
    function logEvent(msg) { STATE.logs.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`); if(STATE.logs.length > 30) STATE.logs.pop(); DOM.logList.innerHTML = STATE.logs.map(l => `<li class="log-item">${l}</li>`).join(""); }
    function triggerHaptics() { if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]); }

    const Utils = {
        escapeHtml: (str) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        niceStep: (maxVal) => { const rough = maxVal / 4; const mag = Math.pow(10, Math.floor(Math.log10(rough || 1))); const norm = rough / mag; return norm < 1.5 ? 1 * mag : norm < 3 ? 2 * mag : norm < 7 ? 5 * mag : 10 * mag; }
    };

    if (typeof L !== "undefined") setTimeout(renderMap, 500);
    document.getElementById("limitInput").value = localSettings.limit; document.getElementById("dropInput").value = localSettings.dropThreshold; document.getElementById("windowInput").value = localSettings.dropWindow; DOM.ntfyTopicInput.value = localSettings.ntfyTopic;

})();
