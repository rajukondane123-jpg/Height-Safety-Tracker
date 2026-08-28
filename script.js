/**
 * ============================================================================
 * ALTIGUARD KERNEL v3.0 - ENTERPRISE CLIENT ENGINE
 * ============================================================================
 * Description: Front-end architecture for structural safety telemetry, spatial
 * geofencing, real-time SVG physics graphing, and autonomous AI auditing.
 * 
 * Architecture:
 * - Singleton State Management (StateTracker)
 * - Modular Hardware Abstraction (GPS, Barometer, Battery)
 * - High-Frequency WebGL/Leaflet Mapping Engine
 * - Dynamic Role-Based Access Control (RBAC) UI Generator
 * - Google Gemini AI Prompt Pipeline
 * ============================================================================
 */

(function () {
    "use strict";

    // ========================================================================
    // 1. SYSTEM CONFIGURATION & LOCAL STORAGE CONTROLLER
    // ========================================================================
    const CONFIG = {
        STORAGE_KEY: "altiguard_enterprise_cfg_v3",
        MAP_TILE_URL: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        MAP_ATTRIBUTION: '&copy; CARTO',
        MAX_TRACE_AGE_MS: 5 * 60 * 1000, // 5 Minutes
        MAX_LOG_HISTORY: 100
    };

    /**
     * Safely interacts with local browser storage.
     */
    const StorageController = {
        save: (key, value) => {
            try { localStorage.setItem(key, JSON.stringify(value)); } 
            catch (e) { console.warn("[SYS_WARN] LocalStorage write blocked.", e); }
        },
        load: (key, fallback) => {
            try { 
                const raw = localStorage.getItem(key); 
                return raw ? JSON.parse(raw) : fallback; 
            } 
            catch (e) { return fallback; }
        }
    };

    // Load active settings
    let settings = StorageController.load(CONFIG.STORAGE_KEY, {
        limit: 2.0,
        dropThreshold: 1.5,
        dropWindow: 4,
        ntfyTopic: "",
        floorHeight: 3.5
    });

    // ========================================================================
    // 2. CENTRALIZED STATE MANAGEMENT
    // ========================================================================
    const state = {
        socketConnected: false,
        roomCode: null,
        userRole: "worker", // 'creator', 'sub-admin', 'worker'
        mySelfId: null,
        
        group: [],
        logs: [],
        alerts: [],
        dangerZones: [],
        
        globalReference: 0,
        isAlerting: false,
        alertTimeoutId: null,
        
        traces: {}, // Stores 5-min locational arrays per user ID
        tracedTargetId: null, // Which user is currently being rendered on map
        
        hardware: {
            batteryLevel: 100,
            watchId: null,
            livePersonId: null, // Determines if THIS device is broadcasting
            baroBaseline: null,
            audioCtx: null
        },
        
        kinematics: {
            history: [], // Stores rolling window of elevations
            lastValidHeight: null,
            lastMoveTime: null
        },
        
        ui: {
            mapInstance: null,
            mapMarkers: {},
            traceLayer: null,
            zoneLayers: []
        }
    };

    // Connect WebSocket
    const socket = io();

    // ========================================================================
    // 3. HARDWARE TELEMETRY ABSTRACTION
    // ========================================================================

    /**
     * Initializes the Web Audio API for emergency tactile feedback.
     */
    function unlockAudioEngine() {
        try {
            state.hardware.audioCtx = state.hardware.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (state.hardware.audioCtx.state === "suspended") {
                state.hardware.audioCtx.resume();
            }
        } catch (e) { console.warn("[HW_WARN] Audio Engine locked by browser."); }
    }

    /**
     * Triggers a high-frequency tactical alert beep.
     */
    function triggerTacticalBeep() {
        if (!state.hardware.audioCtx) return;
        try {
            const osc = state.hardware.audioCtx.createOscillator();
            const gain = state.hardware.audioCtx.createGain();
            osc.type = "square";
            osc.frequency.value = 880; // High pitch alert
            gain.gain.setValueAtTime(0.3, state.hardware.audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, state.hardware.audioCtx.currentTime + 0.4);
            osc.connect(gain).connect(state.hardware.audioCtx.destination);
            osc.start();
            osc.stop(state.hardware.audioCtx.currentTime + 0.4);
        } catch (e) { console.error("[HW_ERR] Oscillator failure", e); }
    }

    /**
     * Triggers hardware vibration motor.
     */
    function triggerHaptics() {
        if (navigator.vibrate) {
            try { navigator.vibrate([300, 100, 300, 100, 600]); } 
            catch (e) { /* Ignore */ }
        }
    }

    /**
     * Initializes hardware battery telemetry.
     */
    function initBatteryTelemetry() {
        if ('getBattery' in navigator) {
            navigator.getBattery().then(b => {
                state.hardware.batteryLevel = Math.round(b.level * 100);
                b.addEventListener('levelchange', () => {
                    state.hardware.batteryLevel = Math.round(b.level * 100);
                    if (state.hardware.batteryLevel <= 15) {
                        socket.emit('logIncident', `⚠️ LOW BATTERY: A tracked hardware node dropped to ${state.hardware.batteryLevel}%.`);
                    }
                });
            });
        }
    }

    /**
     * Physics formula: Converts raw Pascal pressure to relative altitude.
     * @param {number} currentHPa - Current barometric reading
     * @param {number} baseHPa - Reference barometric reading
     * @returns {number} Relative altitude in meters
     */
    function calculatePressureToAltitude(currentHPa, baseHPa) {
        return 44330 * (1 - Math.pow(currentHPa / baseHPa, 1 / 5.255));
    }

    /**
     * Initializes the Barometer sensor if hardware supports it.
     */
    async function initBarometer() {
        if (!("Barometer" in window)) return;
        try {
            const baroSensor = new Barometer({ frequency: 1 });
            baroSensor.addEventListener("reading", () => {
                if (state.hardware.baroBaseline === null) {
                    state.hardware.baroBaseline = baroSensor.pressure;
                }
                state.hardware.currentPressure = baroSensor.pressure;
            });
            baroSensor.start();
        } catch (e) { console.warn("[HW_WARN] Barometer rejected or unavailable."); }
    }

    /**
     * Calculates the current barometric delta.
     * @returns {number|null} Delta in meters
     */
    function getCurrentBaroDelta() {
        if (state.hardware.currentPressure && state.hardware.baroBaseline !== null) {
            return calculatePressureToAltitude(state.hardware.currentPressure, state.hardware.baroBaseline);
        }
        return null;
    }


    // ========================================================================
    // 4. MAP & GEOFENCE ENGINE (LEAFLET)
    // ========================================================================

    /**
     * Initializes the WebGL/Leaflet Topographical Map.
     */
    function initMapEngine() {
        const mapContainer = document.getElementById("map");
        if (!mapContainer || typeof L === "undefined") {
            console.error("[MAP_ERR] Leaflet library missing. Map module aborted.");
            return;
        }

        try {
            // Default initialization over India/Asia
            state.ui.mapInstance = L.map('map', {
                zoomControl: true,
                maxZoom: 19
            }).setView([20.5937, 78.9629], 5);
            
            // Inject Tactical Dark Tiles
            L.tileLayer(CONFIG.MAP_TILE_URL, { 
                attribution: CONFIG.MAP_ATTRIBUTION,
                maxZoom: 19 
            }).addTo(state.ui.mapInstance);

            state.ui.traceLayer = L.layerGroup().addTo(state.ui.mapInstance);

            // Context Menu (Right Click) Geofence Builder
            state.ui.mapInstance.on('contextmenu', (e) => {
                if (state.userRole === "creator" || state.userRole === "sub-admin") {
                    socket.emit('addZone', { lat: e.latlng.lat, lon: e.latlng.lng, radius: 50 });
                    triggerAlertBanner("🗺️ Danger Zone Executed (50m Radius)");
                } else {
                    triggerAlertBanner("⚠️ Access Denied: Only Admins can draw Danger Zones.");
                }
            });

            console.log("[MAP_SYS] Geographic module online.");
        } catch(e) {
            console.error("[MAP_ERR] Initialization failed.", e);
        } 
    }

    /**
     * Syncs map markers, geofences, and tracing lines to the current state.
     */
    function renderMapEngine() {
        if (!state.ui.mapInstance || typeof L === "undefined") return; 
        
        const currentIds = state.group.map(p => p.id); 
        
        // 1. Cleanup orphaned markers
        for (let id in state.ui.mapMarkers) { 
            if (!currentIds.includes(id)) { 
                state.ui.mapInstance.removeLayer(state.ui.mapMarkers[id]); 
                delete state.ui.mapMarkers[id]; 
            } 
        } 
        
        // 2. Render Node Positions
        state.group.forEach(p => { 
            if (p.lat && p.lon) { 
                if (state.ui.mapMarkers[p.id]) {
                    state.ui.mapMarkers[p.id].setLatLng([p.lat, p.lon]); 
                } else {
                    // Custom Tactical Marker SVG
                    const tacticalIcon = L.divIcon({
                        className: 'tactical-marker',
                        html: `<svg width="24" height="24" viewBox="0 0 24 24" fill="${p.id === state.hardware.livePersonId ? '#f59e0b' : '#14b8a6'}"><circle cx="12" cy="12" r="10" stroke="#000" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="#000"/></svg>`,
                        iconSize: [24, 24],
                        iconAnchor: [12, 12]
                    });
                    
                    state.ui.mapMarkers[p.id] = L.marker([p.lat, p.lon], { icon: tacticalIcon })
                        .addTo(state.ui.mapInstance)
                        .bindPopup(`<div style="font-family:monospace; color:#000;"><b>ID:</b> ${p.id}<br><b>Name:</b> ${escapeHtml(p.name)}<br><b>Z:</b> ${p.height.toFixed(2)}m</div>`); 
                }
            } 
        }); 

        // 3. Render Geofences (Danger Zones)
        state.ui.zoneLayers.forEach(layer => state.ui.mapInstance.removeLayer(layer)); 
        state.ui.zoneLayers = [];
        state.dangerZones.forEach(z => {
            const circle = L.circle([z.lat, z.lon], { 
                color: '#ef4444', 
                fillColor: '#ef4444', 
                fillOpacity: 0.3, 
                radius: z.radius,
                weight: 2
            }).addTo(state.ui.mapInstance);
            circle.bindPopup("<b style='color:red;'>⚠️ RESTRICTED DANGER ZONE</b>"); 
            state.ui.zoneLayers.push(circle);
        });

        // 4. Render Active Breadcrumb Trace
        if (state.ui.traceLayer) {
            state.ui.traceLayer.clearLayers();
            if (state.tracedTargetId && state.traces[state.tracedTargetId] && state.traces[state.tracedTargetId].length > 1) {
                const path = state.traces[state.tracedTargetId].map(t => [t.lat, t.lon]);
                const polyline = L.polyline(path, { 
                    color: '#0ea5e9', 
                    weight: 4, 
                    opacity: 0.9, 
                    dashArray: '10, 10' 
                }).addTo(state.ui.traceLayer);
                
                // Auto-fit map to the trace
                state.ui.mapInstance.fitBounds(polyline.getBounds(), { padding: [50, 50] });
            }
        }
    }


    // ========================================================================
    // 5. KINEMATICS & PHYSICS ENGINE
    // ========================================================================

    /**
     * Checks if a worker's trajectory intersects a registered danger zone.
     * @param {Object} person - The worker object containing lat/lon
     */
    function assessGeofenceBreach(person) {
        if (!person.lat || !person.lon || !state.ui.mapInstance || typeof L === "undefined") return;
        
        state.dangerZones.forEach(z => {
            const dist = state.ui.mapInstance.distance([person.lat, person.lon], [z.lat, z.lon]);
            if (dist < z.radius && !person.inZone) {
                person.inZone = true; 
                socket.emit('logIncident', `⚠️ SECTOR BREACH: ${person.name} entered restricted coordinates.`);
                triggerAlertBanner(`⚠️ SECTOR BREACH: ${person.name} penetrated Danger Zone!`); 
                triggerTacticalBeep(); 
                triggerHaptics();
            } else if (dist >= z.radius) {
                person.inZone = false;
            }
        });
    }

    /**
     * Master Fall Detection Algorithm.
     * Analyzes rolling history window to detect severe kinematic drops.
     * @param {Object} person - The worker object
     */
    function assessKinematicDrop(person) {
        const now = Date.now(); 
        state.kinematics.history.push({ t: now, h: person.height });
        
        // Rolling Window Garbage Collection
        const windowMs = settings.dropWindow * 1000; 
        state.kinematics.history = state.kinematics.history.filter(r => now - r.t <= windowMs + 2000);
        
        // Isolate current active window
        const inWindow = state.kinematics.history.filter(r => now - r.t <= windowMs); 
        if (inWindow.length < 2) return;
        
        const peak = Math.max(...inWindow.map(r => r.h)); 
        const drop = peak - person.height;
        
        if (drop >= settings.dropThreshold) { 
            executeEmergencyDropProtocol(person, drop, false); 
            state.kinematics.history = [{ t: now, h: person.height }]; // Reset filter to prevent double-firing
        }
    }

    /**
     * Executes internal alerts and outbound REST hooks when a drop is detected.
     */
    function executeEmergencyDropProtocol(person, dropAmount, isTest) {
        const topicInput = document.getElementById("ntfyTopicInput"); 
        const activeTopic = topicInput ? topicInput.value.trim() : (settings.ntfyTopic || "");
        
        const entry = { 
            id: generateUid(), 
            name: person ? person.name : "System Diagnostic Test", 
            drop: Number(dropAmount.toFixed(2)), 
            lat: person ? person.lat : null, 
            lon: person ? person.lon : null, 
            time: new Date().toISOString(), 
            test: !!isTest, 
            ntfyTopic: activeTopic 
        };
        
        state.alerts.unshift(entry); 
        if (state.alerts.length > 50) state.alerts.length = 50;
        
        if (!isTest) {
            socket.emit('logIncident', `⚠️ KINEMATIC ANOMALY: ${entry.name} dropped ${entry.drop}m.`);
            socket.emit('triggerAlert', entry); 
        }
        
        triggerSiteWideAlarm(); 
        triggerAlertBanner(`⚠️ STRUCTURAL WARNING — ${entry.name} dropped ${entry.drop} m`); 
        triggerHaptics(); 
        triggerTacticalBeep();
        
        // Outbound Anonymous Push via Ntfy
        if (activeTopic) {
            const cleanTopic = activeTopic.replace(/[^a-zA-Z0-9-_]/g, "");
            const payload = `EMERGENCY ALERT: ${entry.name} dropped ${entry.drop}m! Verify status immediately.`;
            
            fetch(`https://ntfy.sh/${cleanTopic}`, { 
                method: 'POST', 
                body: payload, 
                headers: { 
                    'Title': 'Altiguard Command Alert', 
                    'Priority': 'urgent',
                    'Tags': 'rotating_light,skull'
                } 
            }).catch(err => console.warn("[REST_ERR] Ntfy Push Failed.", err));
        }
    }

    /**
     * Processes live GPS feed and injects data into physics models.
     */
    function handleLiveTelemetry(pos) {
        const person = state.group.find(p => p.id === state.hardware.livePersonId); 
        if (!person) { stopLiveTracking(); return; }
        
        const { latitude, longitude, altitude, accuracy } = pos.coords;
        let height = altitude ?? person.height ?? 0;
        
        // Hybrid Sensor Fusion (GPS + Barometer)
        const baroDelta = getCurrentBaroDelta();
        if (baroDelta !== null) { 
            if (person._baroRef === undefined) {
                person._baroRef = height - baroDelta; 
            }
            height = person._baroRef + baroDelta; 
        }
        
        person.lat = latitude; 
        person.lon = longitude; 
        person.height = height; 
        person.accuracy = accuracy; 
        person.battery = state.hardware.batteryLevel; 
        person.updatedAt = new Date().toISOString();
        
        assessKinematicDrop(person); 
        assessGeofenceBreach(person); 
        syncStateToServer(); 
        executeDOMRender();
    }


    // ========================================================================
    // 6. UI & DOM GENERATION ENGINE
    // ========================================================================

    /**
     * Builds and injects missing structural HTML components into the DOM.
     * Prevents reliance on hardcoded HTML templates.
     */
    function ensureDOMScaffolding() {
        const body = document.body;
        const main = document.querySelector("main") || body;

        // 1. Group Authentication Row
        if (!document.getElementById("groupControlWrapper")) {
            const joinBtn = document.getElementById("joinRoomBtn"); 
            if (joinBtn) {
                const wrapper = document.createElement("div"); 
                wrapper.id = "groupControlWrapper"; 
                wrapper.className = "group-control-row";
                wrapper.innerHTML = `
                    <button type="button" id="createGroupBtn" class="primary-btn">Initialize Site Matrix</button>
                    <button type="button" id="joinGroupActionBtn" class="outline-btn">Connect Node</button>
                `;
                joinBtn.parentNode.insertBefore(wrapper, joinBtn); 
                joinBtn.style.display = "none"; 
                
                document.getElementById("createGroupBtn").addEventListener("click", () => {
                    const code = document.getElementById("groupCodeInput")?.value.trim();
                    socket.emit('createGroup', code);
                });
                document.getElementById("joinGroupActionBtn").addEventListener("click", () => {
                    const code = document.getElementById("groupCodeInput")?.value.trim();
                    if (!code) return triggerAlertBanner("Input required: Provide Site Access Code.");
                    socket.emit('joinGroup', code);
                });
            }
        }

        // 2. Summary Telemetry Bar
        if (!document.getElementById("summaryBar")) {
            const bar = document.createElement("div"); 
            bar.id = "summaryBar"; 
            bar.className = "summary-bar";
            bar.innerHTML = `
                <div class="stat-box"><span class="stat-label">Clearance</span><strong id="statRole">SYS_BOOT</strong></div>
                <div class="stat-box"><span class="stat-label">Active Nodes</span><strong id="statActive">0 Tracked</strong></div>
                <div class="stat-box"><span class="stat-label">Command Uplink</span><strong id="statStatus" class="status-secure">CONNECTING...</strong></div>
            `;
            main.insertBefore(bar, main.firstChild);
        }

        // 3. Tactical Admin Controls
        if (!document.getElementById("adminControls")) {
            const ctrl = document.createElement("div"); 
            ctrl.id = "adminControls"; 
            ctrl.className = "admin-controls-row"; 
            ctrl.style.display = "none"; // Hidden by default until role verified
            ctrl.innerHTML = `
                <button id="emergencyBroadcastBtn" class="emergency-broadcast-btn">🚨 Transmit Global Evac</button>
                <button id="exportCsvBtn" class="export-btn">📊 Compile Compliance Log</button>
            `;
            main.insertBefore(ctrl, main.children[1] || null);
            document.getElementById("emergencyBroadcastBtn").addEventListener("click", transmitGlobalEvacuation);
            document.getElementById("exportCsvBtn").addEventListener("click", buildComplianceCSV);
        }

        // 4. Hardware SOS Panic Button
        if (!document.getElementById("sosTriggerBtn")) {
            const sos = document.createElement("button"); 
            sos.id = "sosTriggerBtn"; 
            sos.innerHTML = "🚨 INITIATE SOS";
            sos.onclick = transmitCriticalSOS; 
            body.appendChild(sos);
        }

        // 5. Overlays & Modals
        if (!document.getElementById("sosAlertBanner")) {
            const sosBanner = document.createElement("div"); 
            sosBanner.id = "sosAlertBanner"; 
            body.appendChild(sosBanner);
        }

        if (!document.getElementById("alertBanner")) {
            const banner = document.createElement("div"); 
            banner.id = "alertBanner"; 
            body.appendChild(banner);
        }

        // 6. Gemini AI Diagnostics Plugin
        if (!document.getElementById("aiAdvisorBtn")) {
            const aiBtn = document.createElement("button"); 
            aiBtn.id = "aiAdvisorBtn"; 
            aiBtn.innerHTML = "✨ Execute AI Audit";
            
            // Inline styling for the isolated plugin module
            Object.assign(aiBtn.style, { 
                position: "fixed", bottom: "30px", left: "30px", zIndex: "9999", 
                background: "linear-gradient(135deg, var(--teal), var(--blue))", color: "#000", 
                border: "none", padding: "12px 20px", borderRadius: "30px", 
                fontFamily: "var(--font-display)", fontWeight: "bold", fontSize: "14px", 
                cursor: "pointer", boxShadow: "0 0 20px rgba(20, 184, 166, 0.4)" 
            });
            
            const aiModal = document.createElement("div"); 
            aiModal.id = "aiModal";
            Object.assign(aiModal.style, { 
                position: "fixed", bottom: "80px", left: "30px", zIndex: "9998", 
                background: "rgba(13, 19, 33, 0.95)", backdropFilter: "blur(10px)", 
                border: "1px solid var(--teal)", borderRadius: "var(--radius)", 
                padding: "20px", width: "350px", color: "var(--text-main)", 
                fontFamily: "var(--font-main)", fontSize: "13px", lineHeight: "1.6", 
                boxShadow: "0 10px 40px rgba(0,0,0,0.6)", display: "none", 
                transform: "translateY(10px)", opacity: "0", transition: "all 0.3s ease" 
            });
            
            body.appendChild(aiBtn); 
            body.appendChild(aiModal);

            aiBtn.onclick = () => {
                if (state.group.length === 0) { 
                    aiModal.innerHTML = "⚠️ AI Audit Aborted: No active personnel telemetry available."; 
                    revealModal(aiModal); 
                    return; 
                }
                
                aiBtn.innerHTML = "⏳ AI Analyzing Telemetry...";
                
                const h = Math.max(...state.group.map(p => p.height - state.globalReference)).toFixed(1);
                let lowBatCount = 0;
                state.group.forEach(p => { if (p.battery && p.battery < 20) lowBatCount++; });

                socket.emit('requestAiInsight', { 
                    workerCount: state.group.length, 
                    highestElevation: h, 
                    temperature: "24°C (Simulated)", // Placeholder for future weather API
                    windSpeed: "12 km/h (Simulated)", 
                    zonesCount: state.dangerZones.length, 
                    lowBatteryCount: lowBatCount 
                });
            };

            socket.on('aiInsightResponse', (res) => {
                aiBtn.innerHTML = "✨ Execute AI Audit";
                aiModal.innerHTML = res.error 
                    ? `❌ <b>AI Offline:</b><br>${res.error}` 
                    : `<b style="color:var(--teal); font-family:var(--font-display); font-size:16px;">🤖 GEMINI SAFETY ANALYSIS:</b><br><br>${res.result}`;
                revealModal(aiModal);
            });

            function revealModal(el) {
                el.style.display = "block"; 
                setTimeout(() => { el.style.transform = "translateY(0)"; el.style.opacity = "1"; }, 10);
                setTimeout(() => { el.style.transform = "translateY(10px)"; el.style.opacity = "0"; setTimeout(() => el.style.display="none", 300); }, 15000);
            }
        }
    }


    // ========================================================================
    // 7. SOCKET EVENT HANDLERS (CORE LOGIC)
    // ========================================================================
    
    socket.on('connect', () => { 
        state.socketConnected = true; 
        executeDOMRender(); 
    });
    
    socket.on('disconnect', () => { 
        state.socketConnected = false; 
        triggerAlertBanner("⚠️ CRITICAL: Command uplink severed. Attempting reconnect."); 
        executeDOMRender(); 
    });
    
    socket.on('roleAssigned', ({ role, roomCode }) => {
        state.userRole = role; 
        state.roomCode = roomCode;
        const codeInput = document.getElementById("groupCodeInput"); 
        if (codeInput) codeInput.value = roomCode;
        
        triggerAlertBanner(`Connection Authorized. Clearance Level: ${role.toUpperCase()}`);
        updateRoleUI(); 
        executeDOMRender();
    });

    socket.on('groupError', (msg) => triggerAlertBanner(`⚠️ SYSTEM ERROR: ${msg}`));
    socket.on('syncReference', (ref) => { 
        state.globalReference = ref; 
        const refIn = document.getElementById("referenceInput"); 
        if (refIn) refIn.value = ref; 
        executeDOMRender(); 
    });
    socket.on('syncLogs', (logs) => { 
        state.logs = logs; 
        renderSystemLogs(); 
    });

    socket.on('syncGroup', (serverGroup) => {
        // Evaluate self permissions
        if (state.mySelfId) {
            const me = serverGroup.find(p => p.id === state.mySelfId);
            if (me && me.role !== state.userRole && state.userRole !== 'creator') {
                state.userRole = me.role; 
                triggerAlertBanner(`Privilege Escalation: Clearance updated to ${state.userRole.toUpperCase()}`); 
                updateRoleUI();
            }
        }
        
        state.group = serverGroup;
        
        // Append location to 5-Min Memory Bank
        const now = Date.now();
        state.group.forEach(p => {
            if (p.lat && p.lon) {
                if (!state.traces[p.id]) state.traces[p.id] = [];
                const last = state.traces[p.id][state.traces[p.id].length - 1];
                
                // Save RAM by not pushing identical coordinate frames
                if (!last || Math.abs(last.lat - p.lat) > 0.00001 || Math.abs(last.lon - p.lon) > 0.00001) {
                    state.traces[p.id].push({ lat: p.lat, lon: p.lon, time: now });
                }
                
                // Filter out data older than 5 minutes
                state.traces[p.id] = state.traces[p.id].filter(t => now - t.time <= CONFIG.MAX_TRACE_AGE_MS); 
            }
        });
        
        executeDOMRender();
    });

    socket.on('receiveEmergencyBroadcast', (payload) => {
        triggerHaptics(); 
        triggerTacticalBeep();
        const coordsStr = (payload.lat && payload.lon) 
            ? `<br><a href="https://www.google.com/maps?q=${payload.lat},${payload.lon}" target="_blank" style="color:var(--amber); text-decoration:underline;">📍 INTERCEPT EVACUATION COORDS</a>` 
            : "";
        triggerAlertBanner(`🚨 COMMAND BROADCAST: Rally at ${escapeHtml(payload.name)} [Z: ${payload.height.toFixed(2)}m] ${coordsStr}`);
        
        if (state.ui.mapInstance && payload.lat && payload.lon) {
            state.ui.mapInstance.setView([payload.lat, payload.lon], 16);
        }
    });


    // ========================================================================
    // 8. EMERGENCY OPERATIONS
    // ========================================================================

    function transmitCriticalSOS() {
        if (!state.mySelfId) return triggerAlertBanner("Action Rejected: You must join the grid before issuing an SOS.");
        
        const me = state.group.find(p => p.id === state.mySelfId);
        if (me) {
            socket.emit('triggerSOS', { name: me.name, lat: me.lat, lon: me.lon, height: me.height });
            
            // Push Notification Gateway
            const activeTopic = document.getElementById("ntfyTopicInput")?.value.trim() || settings.ntfyTopic;
            if (activeTopic) {
                const clean = activeTopic.replace(/[^a-zA-Z0-9-_]/g, "");
                fetch(`https://ntfy.sh/${clean}`, { 
                    method: 'POST', 
                    body: `🚨 CRITICAL SOS BY ${me.name} 🚨`, 
                    headers: { 'Title': 'Altiguard SOS', 'Priority': 'urgent', 'Tags': 'sos,rotating_light' } 
                }).catch(()=>{});
            }
        }
    }

    function transmitGlobalEvacuation() {
        if (state.group.length === 0) return triggerAlertBanner("Matrix empty. No nodes available to receive broadcast.");
        
        // Target the traced worker, the active hardware, or the first available worker
        const target = state.group.find(p => p.id === state.tracedTargetId) || 
                       state.group.find(p => p.id === state.hardware.livePersonId) || 
                       state.group[0];
                       
        socket.emit('broadcastEmergencyLocation', { 
            role: state.userRole, 
            name: target.name, 
            height: target.height, 
            lat: target.lat, 
            lon: target.lon 
        });
        triggerAlertBanner(`🚨 Broadcast transmitted for ${target.name}.`);
    }


    // ========================================================================
    // 9. DATA EXPORT COMPLIANCE
    // ========================================================================

    function buildComplianceCSV() {
        if (state.userRole !== "creator" && state.userRole !== "sub-admin") return;
        
        let csv = "ALTIGUARD ENTERPRISE COMPLIANCE REPORT\nDate,Time,Category,Identity/Metric,Status\n";
        const dateStr = new Date().toLocaleDateString();
        
        csv += `\n--- ACTIVE PERSONNEL ROSTER ---\n`;
        state.group.forEach(p => {
            csv += `${dateStr},--,PERSONNEL,ID: ${p.id} | Name: ${p.name},Max Z: ${p.height.toFixed(2)}m | Battery: ${p.battery}%\n`;
        });
        
        csv += `\n--- KERNEL INCIDENT LOGS ---\n`;
        state.logs.forEach(l => { 
            const d = new Date(l.time); 
            csv += `${d.toLocaleDateString()},${d.toLocaleTimeString()},${l.type || 'SYS'},${l.message.replace(/,/g, ' ')},${l.level || 'info'}\n`; 
        });
        
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a'); 
        a.href = URL.createObjectURL(blob);
        a.download = `Altiguard_Compliance_${Date.now()}.csv`; 
        document.body.appendChild(a); 
        a.click(); 
        document.body.removeChild(a);
    }


    // ========================================================================
    // 10. SVG PHYSICS GRAPHING ENGINE
    // ========================================================================

    /**
     * Helper mathematical function to calculate readable grid steps.
     */
    function calculateNiceStep(maxVal) { 
        const rough = maxVal / 4; 
        const mag = Math.pow(10, Math.floor(Math.log10(rough || 1))); 
        const norm = rough / mag; 
        return norm < 1.5 ? 1 * mag : norm < 3 ? 2 * mag : norm < 7 ? 5 * mag : 10 * mag; 
    }

    /**
     * Determines status category based on threshold limits.
     */
    function evalThresholdStatus(relHeight) { 
        return relHeight > settings.limit ? "above" : relHeight < -settings.limit ? "below" : "within"; 
    }

    /**
     * Generates an SVG group containing a stick figure and its data readouts.
     */
    function buildSVGFigure(x, y, status, isLive, name, relHeight, id) { 
        const cls = `figure figure-${status}${isLive ? " figure-live" : ""}`; 
        return `
            <g class="${cls}" data-person-id="${id}" style="--fx: ${x.toFixed(1)}px; --fy: ${y.toFixed(1)}px;">
                ${isLive ? '<circle class="live-halo" r="14"></circle>' : ""}
                <text class="figure-readout" x="0" y="-28" text-anchor="middle">${fmtSigned(relHeight, 2)}m</text>
                <circle class="figure-head" cx="0" cy="-14" r="6"></circle>
                <line class="figure-body" x1="0" y1="-8" x2="0" y2="10"></line>
                <text class="figure-label" x="0" y="39" text-anchor="middle">${escapeHtml(name)}</text>
            </g>
        `; 
    }

    /**
     * Draws the main spatial elevation matrix (graph).
     */
    function renderPhysicsGraph() {
        const svg = document.getElementById("graphSvg"); 
        if (!svg) return;
        if (state.group.length === 0) {
            svg.innerHTML = `<text x="50%" y="50%" fill="var(--text-dim)" text-anchor="middle" font-family="monospace">NO PERSONNEL GEOMETRY DETECTED</text>`;
            return;
        }

        const W = 640, H = 380, marginL = 58, marginR = 20, marginT = 20, marginB = 46;
        const plotW = W - marginL - marginR, plotH = H - marginT - marginB;
        const midY = marginT + plotH / 2;
        
        const rels = state.group.map(p => p.height - state.globalReference); 
        const maxAbs = Math.max(settings.limit * 1.2, ...rels.map(r => Math.abs(r)), 1); 
        const scale = (plotH / 2) / maxAbs; 
        const parts = [];
        
        // 1. Draw Architectural Floor Bands
        const floorH = settings.floorHeight || 3.5;
        const floorPx = floorH * scale;
        
        for (let f = Math.floor(-maxAbs / floorH) - 1; f <= Math.ceil(maxAbs / floorH) + 1; f++) {
            const yTop = midY - (f * floorH) * scale - floorPx;
            const yBot = yTop + floorPx;
            const rT = Math.max(Math.min(yTop, marginT + plotH), marginT);
            const rB = Math.min(Math.max(yBot, marginT), marginT + plotH);
            
            if (rB - rT > 0) {
                const bgClass = Math.abs(f) % 2 === 0 ? 'floor-even' : 'floor-odd';
                parts.push(`<rect x="${marginL}" y="${rT}" width="${plotW}" height="${rB - rT}" class="${bgClass}"></rect>`);
                if (rB - rT > 15) {
                    const label = f >= 0 ? `Level ${f}` : `Sub-Level ${Math.abs(f)}`;
                    parts.push(`<text class="floor-label" x="${marginL + plotW - 5}" y="${rT + 14}" text-anchor="end">${label}</text>`);
                }
            }
        }
        
        // 2. Draw Personnel Geometry
        state.group.forEach((p, i) => { 
            const rel = p.height - state.globalReference;
            const x = marginL + (plotW * (i + 0.5)) / state.group.length;
            const y = midY - rel * scale; 
            parts.push(buildSVGFigure(x, y, evalThresholdStatus(rel), p.id === state.hardware.livePersonId, p.name, rel, p.id)); 
        });
        
        // 3. Draw Grid Lines
        const step = calculateNiceStep(maxAbs);
        for (let v = step; v <= maxAbs; v += step) {
            [v, -v].forEach(val => {
                const y = midY - val * scale; 
                if (y >= marginT && y <= marginT + plotH) {
                    parts.push(`<line class="grid-line" x1="${marginL}" y1="${y}" x2="${marginL + plotW}" y2="${y}"></line>`);
                    parts.push(`<text class="axis-label" x="${marginL - 8}" y="${y + 3}" text-anchor="end">${val > 0 ? "+" : ""}${val}</text>`);
                }
            });
        }
        
        // 4. Draw Datum Baseline
        parts.push(`<line class="baseline" x1="${marginL}" y1="${midY}" x2="${marginL + plotW}" y2="${midY}"></line>`);
        parts.push(`<text class="baseline-label" x="${marginL + plotW}" y="${midY - 8}" text-anchor="end">DATUM ZERO</text>`);
        parts.push(`<text class="axis-label" x="${marginL - 8}" y="${midY + 3}" text-anchor="end">0</text>`);
        
        svg.innerHTML = parts.join("");
    }


    // ========================================================================
    // 11. GENERAL UI RENDERING PIPELINE
    // ========================================================================
    
    function executeDOMRender() {
        renderSummary();
        renderRoster();
        renderPhysicsGraph();
        renderSystemLogs();
        renderMapEngine();
    }

    function renderSummary() {
        const elActive = document.getElementById("statActive");
        const elStatus = document.getElementById("statStatus");
        if (!elActive || !elStatus) return; 
        
        elActive.textContent = `${state.group.length} Active Nodes`;
        
        if (state.isAlerting) { 
            elStatus.className = "status-danger"; 
            elStatus.innerHTML = "🔴 KINEMATIC ANOMALY DETECTED"; 
        } else { 
            elStatus.className = "status-secure"; 
            elStatus.innerHTML = state.socketConnected ? "🟢 SYSTEM NOMINAL" : "🔴 UPLINK SEVERED"; 
        }
    }

    function renderSystemLogs() { 
        const list = document.getElementById("logList"); 
        if (!list) return; 
        
        list.innerHTML = state.logs.slice(0, 30).map(a => {
            const isErr = a.type === 'ALERT' || a.type === 'SOS' || a.type === 'FALL_DETECT';
            const isWarn = a.type === 'GEOFENCE' || a.type === 'BROADCAST';
            const cls = isErr ? 'error' : isWarn ? 'warning' : 'success';
            return `<li class="log-item ${cls}"><span class="log-time">${new Date(a.time).toLocaleTimeString()}</span><span class="log-text"><strong>[${a.type}]</strong> ${escapeHtml(a.message)}</span></li>`;
        }).join(""); 
    }

    function renderRoster() {
        const list = document.getElementById("rosterList");
        const emptyHint = document.getElementById("emptyHint");
        if (!list || !emptyHint) return; 
        
        if (state.group.length === 0) { 
            list.innerHTML = ""; 
            emptyHint.style.display = "block"; 
            return; 
        }
        
        emptyHint.style.display = "none"; 

        list.innerHTML = state.group.map((p) => {
            const rel = p.height - state.globalReference;
            const status = evalThresholdStatus(rel);
            const isSelf = p.id === state.mySelfId;
            const roleIcon = p.role === 'creator' ? '👑' : p.role === 'sub-admin' ? '⭐' : '👷';
            
            // Battery Pill
            const batColor = p.battery < 20 ? 'var(--red)' : 'var(--teal)';
            const batStr = p.battery ? `<span style="color:${batColor}; font-size:11px; margin-left:10px; border:1px solid rgba(255,255,255,0.2); padding:3px 8px; border-radius:6px; font-family:var(--font-mono);">🔋${p.battery}%</span>` : "";
            
            // Permission Logic
            const canRemove = (state.userRole === "creator") || (state.userRole === "sub-admin" && p.role !== "creator") || isSelf;
            const canPromote = (state.userRole === "creator") && !isSelf;

            // HTML Button Builder
            let actions = "";
            if (isSelf) {
                const isTrackingSelf = state.hardware.livePersonId === p.id;
                actions += `<button class="mini-btn track-btn ${isTrackingSelf ? "active" : ""}" data-id="${p.id}">${isTrackingSelf ? "⏹ Halt GPS Uplink" : "📍 Transmit Live GPS"}</button>`;
            }
            if (state.userRole === "creator" || state.userRole === "sub-admin") {
                const isTraced = state.tracedTargetId === p.id;
                actions += `<button class="mini-btn trace-btn ${isTraced ? "active" : ""}" data-id="${p.id}">🗺️ ${isTraced ? "Hide Trace" : "Trace Route (5m)"}</button>`;
            }
            if (canPromote) {
                if (p.role === 'worker') actions += `<button class="mini-btn promote-btn" data-id="${p.id}" style="color:var(--amber); border-color:var(--amber);">⭐ Grant Admin</button>`;
                else if (p.role === 'sub-admin') actions += `<button class="mini-btn demote-btn" data-id="${p.id}">⬇️ Revoke Admin</button>`;
            }
            if (canRemove) {
                actions += `<button class="mini-btn remove-btn" data-id="${p.id}" style="color:var(--red); border-color:rgba(239,68,68,0.4);">${isSelf && state.userRole !== 'creator' ? '✕ Disconnect' : '✕ Eject Node'}</button>`;
            }

            return `
            <li class="roster-item ${p.inZone ? "zone-breach" : ""}">
                <div class="roster-info">
                    <strong>${roleIcon} ${escapeHtml(p.name)} ${isSelf ? '<small style="color:var(--blue); font-family:var(--font-mono); font-size:10px;">(THIS DEVICE)</small>' : ''} ${batStr}</strong>
                    <span class="roster-sub">Z: ${p.height.toFixed(2)}m · Data Source: ${p.method.toUpperCase()}</span>
                </div>
                <div class="roster-status status-${status}">${fmtSigned(rel, 2)} m<small>STATUS: ${status.toUpperCase()}</small></div>
                <div class="roster-actions">${actions}</div>
            </li>`;
        }).join("");
    }

    function updateRoleUI() {
        const roleBadge = document.getElementById("statRole"); 
        if (roleBadge) roleBadge.textContent = state.userRole.toUpperCase();
        
        const ctrl = document.getElementById("adminControls");
        if (ctrl) ctrl.style.display = (state.userRole === "creator" || state.userRole === "sub-admin") ? "flex" : "none";
    }

    // ========================================================================
    // 12. UTILITY & HELPER FUNCTIONS
    // ========================================================================
    function triggerSiteWideAlarm() { 
        state.isAlerting = true; 
        clearTimeout(state.alertTimeoutId); 
        renderSummary(); 
        state.alertTimeoutId = setTimeout(() => { 
            state.isAlerting = false; 
            renderSummary(); 
        }, 15000); 
    }

    function triggerAlertBanner(msg) { 
        const banner = document.getElementById("alertBanner"); 
        if (!banner) return; 
        banner.innerHTML = msg; 
        banner.classList.add("show"); 
        setTimeout(() => banner.classList.remove("show"), 6000); 
    }
    
    function flashFigure(id) { 
        const el = document.querySelector(`.figure[data-person-id="${id}"]`); 
        if (!el) return; 
        el.classList.add("figure-flash"); 
        setTimeout(() => el.classList.remove("figure-flash"), 4000); 
    }

    function syncStateToServer() { 
        if (state.socketConnected) socket.emit('updateGroup', state.group); 
    }
    
    function generateUid() { 
        return "OP-" + Math.random().toString(36).slice(2, 9).toUpperCase(); 
    }
    
    function escapeHtml(str) { 
        return String(str).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); 
    }
    
    function fmtSigned(n, digits) { 
        return (n >= 0 ? "+" : "") + n.toFixed(digits); 
    }


    // ========================================================================
    // 13. HARDWARE CONTROL (START/STOP)
    // ========================================================================
    function activateLiveTelemetry() {
        if (!navigator.geolocation) return triggerAlertBanner("HW_ERR: Geolocation not supported on this device.");
        
        haltLiveTelemetry(); 
        unlockAudioEngine(); 
        state.hardware.livePersonId = state.mySelfId;
        
        state.hardware.watchId = navigator.geolocation.watchPosition(
            handleLiveTelemetry, 
            (err) => triggerAlertBanner(`GPS Error: ${err.message}`), 
            { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
        );
        executeDOMRender();
    }

    function haltLiveTelemetry() {
        if (state.hardware.watchId !== null) { 
            navigator.geolocation.clearWatch(state.hardware.watchId); 
            state.hardware.watchId = null; 
        } 
        state.hardware.livePersonId = null; 
        executeDOMRender();
    }


    // ========================================================================
    // 14. KERNEL BOOT SEQUENCE
    // ========================================================================
    function bootKernel() {
        console.log("[SYS_BOOT] Altiguard Enterprise Client Initializing...");
        
        ensureDOMScaffolding();
        
        // Bind Form Submission
        const addForm = document.getElementById("addForm");
        if (addForm) {
            addForm.addEventListener("submit", (e) => {
                e.preventDefault(); 
                const nameEl = document.getElementById("nameInput"); 
                const name = nameEl ? nameEl.value.trim() : ""; 
                if (!name) return;
                
                const personId = generateUid(); 
                if (!state.mySelfId) state.mySelfId = personId;
                
                // Read manual overrides or pending captures
                let method = "manual";
                let h = 0, l_lat = null, l_lon = null;
                
                const manH = document.getElementById("manualHeight");
                if (manH && manH.value !== "") {
                    h = parseFloat(manH.value);
                    method = "manual";
                }

                const person = { 
                    id: personId, 
                    name, 
                    role: state.userRole, 
                    battery: state.hardware.batteryLevel, 
                    inZone: false, 
                    height: h, 
                    lat: l_lat, 
                    lon: l_lon, 
                    method: method, 
                    updatedAt: new Date().toISOString() 
                };
                
                state.group.push(person); 
                syncStateToServer(); 
                
                // Clear Form
                ["nameInput", "workerPhoneInput", "manualHeight", "manualLat", "manualLon"].forEach(id => { 
                    const el = document.getElementById(id); if (el) el.value = ""; 
                }); 
                
                executeDOMRender();
            });
        }

        // Bind Datum Calibrator
        const setRefBtn = document.getElementById("setRefBtn"); 
        if (setRefBtn) { 
            setRefBtn.addEventListener("click", () => { 
                const val = parseFloat(document.getElementById("referenceInput")?.value); 
                if (!isNaN(val)) { 
                    state.globalReference = val; 
                    if (state.socketConnected) socket.emit('updateReference', val); 
                    executeDOMRender(); 
                } 
            }); 
        }
        
        const testAlertBtn = document.getElementById("testAlertBtn"); 
        if (testAlertBtn) testAlertBtn.addEventListener("click", () => executeEmergencyDropProtocol(null, 1.80, true));

        // Bind Roster Event Delegation (Trace, Kick, Promote)
        const rosterList = document.getElementById("rosterList");
        if (rosterList) {
            rosterList.addEventListener("click", (e) => {
                const id = e.target.dataset.id;
                if (!id) return;
                
                if (e.target.closest(".track-btn")) { 
                    if (state.hardware.livePersonId === id) haltLiveTelemetry(); 
                    else activateLiveTelemetry(); 
                } 
                else if (e.target.closest(".trace-btn")) { 
                    if (state.tracedTargetId === id) state.tracedTargetId = null; 
                    else state.tracedTargetId = id; 
                    executeDOMRender(); 
                }
                else if (e.target.closest(".remove-btn")) { 
                    if (state.hardware.livePersonId === id) haltLiveTelemetry(); 
                    socket.emit('removeMember', { personId: id, requestedByPersonId: state.mySelfId, requesterRole: state.userRole }); 
                }
                else if (e.target.closest(".promote-btn")) { 
                    const p = state.group.find(x => x.id === id); 
                    if (p) { p.role = 'sub-admin'; syncStateToServer(); } 
                }
                else if (e.target.closest(".demote-btn")) { 
                    const p = state.group.find(x => x.id === id); 
                    if (p) { p.role = 'worker'; syncStateToServer(); } 
                }
            });
        }

        // Bind Persistent Settings Autosave
        const saveSettings = () => { 
            settings.limit = parseFloat(document.getElementById("limitInput")?.value) || 2; 
            settings.dropThreshold = parseFloat(document.getElementById("dropInput")?.value) || 1.5; 
            settings.dropWindow = parseInt(document.getElementById("windowInput")?.value, 10) || 4; 
            settings.ntfyTopic = document.getElementById("ntfyTopicInput")?.value.trim() || ""; 
            settings.floorHeight = parseFloat(document.getElementById("floorInput")?.value) || 3.5; 
            StorageController.save(CONFIG.STORAGE_KEY, settings); 
            executeDOMRender(); 
        };
        ["limitInput", "dropInput", "windowInput", "ntfyTopicInput", "floorInput"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener("input", saveSettings);
        });

        // Init Hardware Subsystems
        initMapEngine(); 
        initBarometer(); 
        initBatteryTelemetry();
        executeDOMRender();
    }

    // Execute Boot Sequence when DOM is ready
    document.addEventListener("DOMContentLoaded", bootKernel);

})();
