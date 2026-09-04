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

    async function fetchWithTimeout(resource, options = {}) {
        const { timeout = 8000 } = options;
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(resource, { ...options, signal: controller.signal });
            clearTimeout(id);
            return response;
        } catch (err) {
            clearTimeout(id);
            throw err;
        }
    }

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
        DEFAULT_NTFY: "",
        DEFAULT_GEOFENCE: 500
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

    async function initBarometer() {
        if (!("Barometer" in window)) return;
        try {
            if (navigator.permissions) {
                const status = await navigator.permissions.query({ name: "barometer" });
                if (status.state === "denied") return;
            }
            STATE.baroSensor = new Barometer({ frequency: 1 });
            STATE.baroSensor.addEventListener("reading", () => {
                if (STATE.baroBaseline === null) STATE.baroBaseline = STATE.baroSensor.pressure;
            });
            STATE.baroSensor.addEventListener("error", () => { STATE.baroSensor = null; });
            STATE.baroSensor.start();
        } catch (e) {}
    }

    function currentBaroDelta() {
        if (STATE.baroSensor && STATE.baroBaseline !== null && typeof STATE.baroSensor.pressure === "number") {
            return 44330 * (1 - Math.pow(STATE.baroSensor.pressure / STATE.baroBaseline, 1 / 5.255));
        }
        return null;
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

        if (isPrivileged && DOM.ntfyTopicInput && DOM.ntfyTopicInput.value) {
            socket.emit('updateNtfyTopic', DOM.ntfyTopicInput.value.trim());
        }

        showAlert(`Uplink Established: ${STATE.groupCode} [${STATE.role.toUpperCase()}]`);
        renderUI();
    });

    socket.on('syncGroup', (members) => { STATE.group = members; renderUI(); });
    socket.on('syncBaseline', (baseline) => { STATE.globalBaseline = baseline; if(DOM.referenceInput) DOM.referenceInput.value = baseline; renderUI(); });
    
    // Worker Map Sync & Auto-Camera Fit
    socket.on('syncGeofence', (radius) => { 
        STATE.geofenceRadius = radius; 
        if(DOM.geofenceRadiusInput && parseFloat(DOM.geofenceRadiusInput.value) !== radius) {
            DOM.geofenceRadiusInput.value = radius; 
        }
        renderMap(); 
        if (STATE.geofenceCircle && STATE.mapInstance) {
            STATE.mapInstance.fitBounds(STATE.geofenceCircle.getBounds(), { padding: [20, 20] });
        }
    });

    socket.on('syncNtfyTopic', (topic) => { if(DOM.ntfyTopicInput) DOM.ntfyTopicInput.value = topic; });
    socket.on('receiveAlert', (data) => { showAlert(`⚠️ FALL DETECTED: ${data.name} (${data.drop}m)`); logEvent(`⚠️ Fall: ${data.name} (${data.drop}m)`); triggerSiren(); });
    socket.on('receiveSOS', (payload) => { showAlert(`🚨 SOS PANIC: ${payload.name}`); logEvent(`🚨 SOS: ${payload.name}`); triggerSiren(); });

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

    async function fetchWeatherAndAQI(lat, lon) {
        try {
            const weatherRes = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,surface_pressure`);
            const weatherData = await weatherRes.json();
            const aqiRes = await fetchWithTimeout(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=european_aqi`);
            const aqiData = await aqiRes.json();

            const current = weatherData.current;
            const temp = current.temperature_2m;
            const feels = current.apparent_temperature;
            const hum = current.relative_humidity_2m;
            const wind = current.wind_speed_10m;
            const press = current.surface_pressure;
            const code = current.weather_code;
            const aqi = aqiData.current.european_aqi;

            if(document.getElementById("wTemp")) document.getElementById("wTemp").innerText = `${temp}°C`;
            if(document.getElementById("wFeels")) document.getElementById("wFeels").innerText = `${feels}°C`;
            if(document.getElementById("wHum")) document.getElementById("wHum").innerText = `${hum}%`;
            if(document.getElementById("wWind")) document.getElementById("wWind").innerText = `${wind} km/h`;
            if(document.getElementById("wPress")) document.getElementById("wPress").innerText = `${Math.round(press)} hPa`;
            
            const aqiEl = document.getElementById("wAqi");
            if(aqiEl) {
                aqiEl.innerText = aqi;
                aqiEl.className = "aqi-badge";
                if (aqi < 40) aqiEl.classList.add("aqi-good");
                else if (aqi < 80) aqiEl.classList.add("aqi-mod");
                else aqiEl.classList.add("aqi-poor");
            }

            const iconBox = document.getElementById("weatherIconBox");
            const conditionEl = document.getElementById("wCondition");
            
            if(conditionEl && iconBox) {
                let conditionText = "Unknown";
                let iconHtml = "";

                if (code === 0) { conditionText = "Clear Sky"; iconHtml = `<div class="anim-sun"></div>`; }
                else if (code === 1 || code === 2) { conditionText = "Partly Cloudy"; iconHtml = `<div class="anim-sun-cloud-wrapper"><div class="anim-sun"></div><div class="anim-cloud"></div></div>`; }
                else if (code === 3) { conditionText = "Overcast"; iconHtml = `<div class="anim-cloud" style="filter: brightness(0.6);"></div>`; }
                else if (code === 45 || code === 48) { conditionText = "Foggy"; iconHtml = `<div class="anim-cloud" style="opacity: 0.5;"></div>`; }
                else if (code >= 51 && code <= 57) { conditionText = "Drizzle"; iconHtml = `<div class="anim-cloud anim-rain"></div>`; }
                else if (code >= 61 && code <= 67) { conditionText = "Heavy Rain"; iconHtml = `<div class="anim-cloud anim-rain" style="filter: brightness(0.6);"></div>`; }
                else if (code >= 71 && code <= 77) { conditionText = "Snowfall"; iconHtml = `<div class="anim-cloud anim-snow"></div>`; }
                else if (code >= 80 && code <= 82) { conditionText = "Rain Showers"; iconHtml = `<div class="anim-sun-cloud-wrapper"><div class="anim-sun"></div><div class="anim-cloud anim-rain"></div></div>`; }
                else if (code >= 85 && code <= 86) { conditionText = "Snow Showers"; iconHtml = `<div class="anim-cloud anim-snow"></div>`; }
                else if (code >= 95 && code <= 99) { conditionText = "Thunderstorm"; iconHtml = `<div class="anim-cloud anim-rain anim-lightning"></div>`; }
                else { conditionText = "Unstable Air"; iconHtml = `<div class="anim-cloud"></div>`; }

                conditionEl.innerText = conditionText;
                iconBox.innerHTML = iconHtml;
            }

            const mapHudTemp = document.getElementById("hudTemp");
            const mapHudWind = document.getElementById("hudWind");
            if(mapHudTemp) mapHudTemp.innerHTML = `${temp}&deg;C`;
            if(mapHudWind) mapHudWind.innerHTML = `${wind} km/h`;

        } catch (e) {}
    }

    async function fetchAddress(lat, lon) {
        try {
            const res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`);
            const data = await res.json();
            if (data && data.address) { const addr = data.address; return `${addr.road || addr.suburb || ''}, ${addr.city || addr.town || addr.county || ''} - ${addr.postcode || ''}`; }
            return "Coordinates locked.";
        } catch(e) { return "Coordinates locked."; }
    }

    function fetchHospitals() {
        if (!STATE.mapInstance || STATE.mapInstance.getZoom() < 11 || typeof L === "undefined") return; 
        const bounds = STATE.mapInstance.getBounds();
        const query = `[out:json][timeout:10];node["amenity"="hospital"](${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()});out;`;
        
        fetchWithTimeout(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, { timeout: 8000 })
            .then(res => res.json())
            .then(data => {
                STATE.hospitalLayer.clearLayers(); 
                if (data && data.elements) {
                    data.elements.forEach(item => {
                        if (item.lat && item.lon) {
                            const name = (item.tags && item.tags.name) ? item.tags.name : "Emergency Hospital";
                            const icon = L.divIcon({ className: '', html: `<div style="background: #0a0f1c; border: 2px solid #ef4444; border-radius: 50%; width: 25px; height: 25px; box-shadow: 0 0 10px #ef4444;"></div>`, iconSize: [25, 25] });
                            STATE.hospitalLayer.addLayer(L.marker([item.lat, item.lon], { icon: icon }).bindPopup(`<b>🚑 ${Utils.escapeHtml(name)}</b>`));
                        }
                    });
                }
            }).catch(err => {});
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
        triggerSiren(); 
        if(DOM.gpsReadout) { DOM.gpsReadout.hidden = false; DOM.gpsReadout.innerHTML = `<div class="spinner" style="width:15px;height:15px;display:inline-block;vertical-align:middle;margin-right:10px;"></div> Acquiring Satellite Lock...`; }
        navigator.geolocation.getCurrentPosition(async (pos) => {
            STATE.pendingLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude, height: pos.coords.altitude || 0 };
            const [address] = await Promise.all([ fetchAddress(pos.coords.latitude, pos.coords.longitude), fetchWeatherAndAQI(pos.coords.latitude, pos.coords.longitude) ]);
            if(DOM.gpsReadout) DOM.gpsReadout.innerHTML = `<strong style="color:var(--brand-primary);">📍 Lock Acquired</strong><br><span style="color:#ccc;">${address}</span>`;
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
            if (pLat !== null && pLon !== null) { fetchWeatherAndAQI(pLat, pLon); if(STATE.mapInstance) STATE.mapInstance.flyTo([pLat, pLon], 16); }
        } else if (STATE.pendingLocation) {
            pLat = STATE.pendingLocation.lat; pLon = STATE.pendingLocation.lon; pHeight = STATE.pendingLocation.height;
            if (STATE.mapInstance) STATE.mapInstance.flyTo([pLat, pLon], 18);
        }

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
        
        if(DOM.geofenceRadiusInput && (STATE.role === 'admin' || STATE.role === 'creator')) {
            const rad = parseFloat(DOM.geofenceRadiusInput.value) || CONFIG.DEFAULT_GEOFENCE;
            if (STATE.geofenceRadius !== rad) {
                localSettings.geofenceRadius = rad;
                STATE.geofenceRadius = rad; 
                socket.emit('updateGeofenceRadius', rad);
                
                const adminNode = STATE.group.find(p => p.role === 'admin' || p.role === 'creator');
                if (adminNode && adminNode.lat !== null && STATE.mapInstance && STATE.geofenceCircle) {
                    STATE.geofenceCircle.setRadius(rad);
                    STATE.mapInstance.fitBounds(STATE.geofenceCircle.getBounds(), { padding: [20, 20] });
                } else if (!adminNode || adminNode.lat === null) {
                    showAlert("⚠️ Inject yourself into the grid first to map the Perimeter Center!");
                }
            }
        }

        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(localSettings)); 
        
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

    function checkGeofenceBreach(person) {
        if (STATE.group.length === 0 || person.lat === null || person.lon === null) return;
        const adminNode = STATE.group.find(p => p.role === 'admin' || p.role === 'creator');
        
        if (adminNode && adminNode.lat && adminNode.lon && adminNode.id !== person.id) {
            const dist = Utils.calculateDistance(adminNode.lat, adminNode.lon, person.lat, person.lon);
            if (dist > STATE.geofenceRadius) {
                if (!person.lastGeoAlert || Date.now() - person.lastGeoAlert > 10000) {
                    showAlert(`🚨 GEOFENCE BREACH: ${person.name} is ${Math.round(dist)}m away!`);
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
            
            const tolerance = 0.1;
            let statusClass = "status-within"; 
            if (relHeight > tolerance) statusClass = "status-above"; 
            else if (relHeight < -tolerance) statusClass = "status-below"; 

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

    // --- PERFECTED SMART SCALING GRAPH ---
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

        const startFloor = Math.floor(-maxAbs / floorH) - 1;
        const endFloor = Math.ceil(maxAbs / floorH) + 1;
        
        // Smart Scaling logic to completely prevent the barcode rendering bug
        const floorSpacingPx = floorH * scaleY;

        // ONLY draw individual floors if they are comfortably spaced apart (>15 pixels)
        if (floorSpacingPx > 15) {
            for (let f = startFloor; f <= endFloor; f++) {
                const yFloor = midY - (f * floorH) * scaleY;
                if (yFloor >= paddingTopBottom && yFloor <= H - paddingTopBottom) {
                    if (f !== 0) { 
                        svgHtml += `<line class="floor-line" x1="${paddingLeft}" y1="${yFloor}" x2="${W - paddingRight}" y2="${yFloor}"></line>`;
                        
                        // Only draw the text labels if there's even MORE space (>30 pixels)
                        if (floorSpacingPx > 30) {
                            const labelStr = f > 0 ? `Lvl ${f}` : `Bsmnt ${Math.abs(f)}`;
                            svgHtml += `<text x="${W - paddingRight - 10}" y="${yFloor - 8}" class="floor-label" text-anchor="end">${labelStr}</text>`;
                        }
                    }
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
            
            const tolerance = 0.1;
            let status = "within"; // Cyan (On Line)
            if (rel > tolerance) status = "above"; // Green
            else if (rel < -tolerance) status = "below"; // Red

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
            STATE.hospitalLayer = L.layerGroup().addTo(STATE.mapInstance);
            
            const weatherControl = L.control({position: 'topright'});
            weatherControl.onAdd = function () {
                const div = L.DomUtil.create('div', 'weather-hud');
                div.innerHTML = `SITE ATMOSPHERE<br><span id="hudTemp">--&deg;C</span> | <span id="hudWind">-- km/h</span>`;
                return div;
            };
            weatherControl.addTo(STATE.mapInstance);

            STATE.mapInstance.on('moveend', () => {
                clearTimeout(STATE.hospitalTimeout);
                STATE.hospitalTimeout = setTimeout(fetchHospitals, 1500); 
            });
        }
        if (!STATE.mapInstance) return;

        const adminNode = STATE.group.find(p => p.role === 'admin' || p.role === 'creator');
        if (adminNode && adminNode.lat !== null && adminNode.lon !== null) {
            const centerLatLng = [adminNode.lat, adminNode.lon];
            if (STATE.geofenceCircle) {
                STATE.geofenceCircle.setLatLng(centerLatLng);
                STATE.geofenceCircle.setRadius(STATE.geofenceRadius);
            } else {
                STATE.geofenceCircle = L.circle(centerLatLng, {
                    color: '#ff0055', fillColor: '#ff0055', fillOpacity: 0.1,
                    radius: STATE.geofenceRadius, weight: 2, dashArray: '5, 5'
                }).addTo(STATE.mapInstance);
            }
        } else if (STATE.geofenceCircle) {
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

    initBarometer();
    if (typeof L !== "undefined") setTimeout(renderMap, 500);
    try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch(e){}

    if(DOM.limitInput) DOM.limitInput.value = localSettings.limit; 
    if(DOM.dropInput) DOM.dropInput.value = localSettings.dropThreshold; 
    if(DOM.windowInput) DOM.windowInput.value = localSettings.dropWindow; 
    if(DOM.floorInput) DOM.floorInput.value = localSettings.floorHeight;
    if(DOM.ntfyTopicInput) DOM.ntfyTopicInput.value = localSettings.ntfyTopic;
    if(DOM.geofenceRadiusInput) DOM.geofenceRadiusInput.value = localSettings.geofenceRadius || CONFIG.DEFAULT_GEOFENCE;

})();
