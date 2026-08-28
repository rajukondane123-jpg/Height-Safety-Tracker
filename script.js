/**
 * ==========================================================================================
 * ALTIGUARD KERNEL v4.0 - ENTERPRISE TACTICAL COMMAND ENGINE
 * ==========================================================================================
 * Description: Advanced front-end architecture for structural safety telemetry, spatial
 * geofencing, real-time SVG physics graphing, autonomous AI auditing, and sensor fusion.
 * 
 * Architecture & Design Patterns:
 * - Singleton Namespace Architecture (Altiguard.*)
 * - Extensible Sensor Fusion (GPS + Barometric Calculation with Moving Averages)
 * - High-Frequency WebGL/Leaflet Mapping Engine with Context Menus
 * - Dynamic Role-Based Access Control (RBAC) UI Generator
 * - Google Gemini AI Prompt Pipeline & Context Management
 * - Asynchronous Notification Queue (Prevents Alert Overlap)
 * - Local Telemetry Caching (Offline Persistence)
 * 
 * Developer: Vaibhav Raju Kondane
 * ==========================================================================================
 */

(function () {
    "use strict";

    // ======================================================================================
    // 1. CONFIGURATION & CONSTANTS
    // ======================================================================================
    const AltiguardConfig = {
        VERSION: "4.0.0-ENTERPRISE",
        STORAGE_KEY: "altiguard_enterprise_cfg_v4",
        OFFLINE_CACHE_KEY: "altiguard_offline_telemetry",
        
        MAP: {
            TILE_URL: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
            ATTRIBUTION: '&copy; <a href="https://carto.com/attributions">CARTO</a>',
            DEFAULT_LAT: 20.5937,
            DEFAULT_LON: 78.9629,
            DEFAULT_ZOOM: 5,
            MAX_ZOOM: 19
        },
        
        PHYSICS: {
            MAX_TRACE_AGE_MS: 5 * 60 * 1000, // 5 Minute rolling memory for breadcrumbs
            DEFAULT_LIMIT: 2.0,
            DEFAULT_DROP_THRESHOLD: 1.5,
            DEFAULT_DROP_WINDOW: 4,
            DEFAULT_FLOOR_HEIGHT: 3.5,
            SMOOTHING_FACTOR: 3 // Moving average window size for barometric smoothing
        },

        NETWORK: {
            FETCH_TIMEOUT_MS: 8000,
            MAX_LOG_HISTORY: 100,
            ALERT_DURATION_MS: 12000
        },

        UI: {
            COLORS: {
                TEAL: "#14b8a6",
                RED: "#f43f5e",
                AMBER: "#f59e0b",
                BLUE: "#0ea5e9",
                DARK: "#0f172a",
                TEXT_MAIN: "#f8fafc"
            }
        }
    };

    // ======================================================================================
    // 2. UTILITY & MATHEMATICAL FUNCTIONS
    // ======================================================================================
    const Utils = {
        /**
         * Safely reads and writes to browser localStorage.
         */
        Storage: {
            save: (key, value) => {
                try { localStorage.setItem(key, JSON.stringify(value)); } 
                catch (e) { console.warn("[SYS_WARN] LocalStorage write blocked.", e); }
            },
            load: (key, fallback) => {
                try { 
                    const raw = localStorage.getItem(key); 
                    return raw ? JSON.parse(raw) : fallback; 
                } catch (e) { return fallback; }
            }
        },

        /**
         * Generates a unique secure identifier for internal objects.
         */
        generateUid: () => {
            return "OP-" + Math.random().toString(36).slice(2, 10).toUpperCase() + "-" + Date.now().toString(36).toUpperCase();
        },

        /**
         * Sanitizes string inputs to prevent XSS injection.
         */
        escapeHtml: (str) => {
            if (!str) return "";
            return String(str).replace(/[&<>"']/g, (ch) => ({ 
                "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" 
            }[ch]));
        },

        /**
         * Formats a number with explicit positive/negative signs.
         */
        fmtSigned: (n, digits) => {
            if (typeof n !== 'number' || isNaN(n)) return "0.00";
            return (n >= 0 ? "+" : "") + n.toFixed(digits);
        },

        /**
         * Calculates readable grid step intervals for the SVG chart.
         */
        calculateNiceStep: (maxVal) => {
            const rough = maxVal / 4;
            const mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
            const norm = rough / mag;
            return norm < 1.5 ? 1 * mag : norm < 3 ? 2 * mag : norm < 7 ? 5 * mag : 10 * mag;
        },

        /**
         * Advanced Fetch Wrapper with AbortController for strict timeouts.
         */
        fetchWithTimeout: async (resource, options = {}) => {
            const { timeout = AltiguardConfig.NETWORK.FETCH_TIMEOUT_MS } = options; 
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), timeout);
            try { 
                const res = await fetch(resource, { ...options, signal: controller.signal }); 
                clearTimeout(id); 
                return res; 
            } catch (err) { 
                clearTimeout(id); 
                throw err; 
            }
        },

        /**
         * Calculates moving average to filter out barometric noise.
         */
        calculateMovingAverage: (array, windowSize) => {
            if (!array || array.length === 0) return 0;
            const subset = array.slice(-windowSize);
            const sum = subset.reduce((a, b) => a + b, 0);
            return sum / subset.length;
        }
    };

    // Load active settings
    let SystemSettings = Utils.Storage.load(AltiguardConfig.STORAGE_KEY, {
        limit: AltiguardConfig.PHYSICS.DEFAULT_LIMIT,
        dropThreshold: AltiguardConfig.PHYSICS.DEFAULT_DROP_THRESHOLD,
        dropWindow: AltiguardConfig.PHYSICS.DEFAULT_DROP_WINDOW,
        ntfyTopic: "",
        floorHeight: AltiguardConfig.PHYSICS.DEFAULT_FLOOR_HEIGHT
    });

    // ======================================================================================
    // 3. CENTRALIZED STATE MANAGEMENT
    // ======================================================================================
    const AppState = {
        network: {
            socket: io(), // Auto-connects to origin server
            isConnected: false,
            offlineQueue: [] // Holds telemetry if connection drops
        },
        identity: {
            roomCode: null,
            role: "worker", // Roles: 'creator', 'sub-admin', 'worker'
            personId: null
        },
        telemetry: {
            group: [],
            logs: [],
            dangerZones: [],
            globalReference: 0,
            traces: {}, // Time-series array per person ID: { id: [{lat, lon, time}] }
            tracedTargetId: null // ID of the specific worker being drawn on the map
        },
        hardware: {
            batteryLevel: 100,
            watchId: null,
            liveTrackingId: null, // Determines if THIS device is pushing GPS
            audioCtx: null,
            baroBaseline: null,
            currentPressure: null,
            pressureHistory: [] // Used for smoothing algorithm
        },
        kinematics: {
            isAlerting: false,
            alertTimeoutId: null,
            history: [] // Rolling window for drop detection
        },
        ui: {
            mapInstance: null,
            mapMarkers: {},
            traceLayer: null,
            zoneLayers: [],
            isModalOpen: false
        }
    };

    // ======================================================================================
    // 4. AUDIO & HAPTIC FEEDBACK ENGINE
    // ======================================================================================
    const FeedbackEngine = {
        /**
         * Unlocks Web Audio API for iOS/Android compliance. Must be called on user interaction.
         */
        unlockAudio: () => {
            try {
                if (!AppState.hardware.audioCtx) {
                    AppState.hardware.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                }
                if (AppState.hardware.audioCtx.state === "suspended") {
                    AppState.hardware.audioCtx.resume();
                }
            } catch (e) { 
                console.warn("[HW_WARN] Audio Engine locked by browser context."); 
            }
        },

        /**
         * Synthesizes a high-frequency tactical square wave for emergencies.
         */
        triggerTacticalBeep: () => {
            if (!AppState.hardware.audioCtx) return;
            try {
                const ctx = AppState.hardware.audioCtx;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                
                osc.type = "square";
                osc.frequency.setValueAtTime(880, ctx.currentTime); // 880Hz Pitch
                osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.3); // Drop pitch
                
                gain.gain.setValueAtTime(0.3, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
                
                osc.connect(gain).connect(ctx.destination);
                osc.start();
                osc.stop(ctx.currentTime + 0.5);
            } catch (e) { 
                console.error("[HW_ERR] Oscillator sequence failure", e); 
            }
        },

        /**
         * Triggers vibration motor in a specific SOS pattern.
         */
        triggerSOSPattern: () => {
            if (navigator.vibrate) {
                try { 
                    // SOS Morse Code Pattern (3 short, 3 long, 3 short)
                    navigator.vibrate([100, 100, 100, 100, 100, 200, 300, 100, 300, 100, 300, 200, 100, 100, 100, 100, 100]); 
                } catch (e) { /* Ignore if unsupported */ }
            }
        },

        /**
         * Triggers a standard short vibration for warnings.
         */
        triggerWarningVibe: () => {
            if (navigator.vibrate) {
                try { navigator.vibrate([200, 100, 200]); } catch (e) { }
            }
        }
    };

    // ======================================================================================
    // 5. HARDWARE SENSOR INTEGRATION
    // ======================================================================================
    const SensorEngine = {
        /**
         * Connects to device Battery API to monitor field equipment status.
         */
        initBatteryTelemetry: () => {
            if ('getBattery' in navigator) {
                navigator.getBattery().then(b => {
                    AppState.hardware.batteryLevel = Math.round(b.level * 100);
                    b.addEventListener('levelchange', () => {
                        AppState.hardware.batteryLevel = Math.round(b.level * 100);
                        if (AppState.hardware.batteryLevel <= 15 && AppState.identity.personId) {
                            AppState.network.socket.emit('logIncident', `⚠️ HW_WARN: Device battery critical (${AppState.hardware.batteryLevel}%).`);
                        }
                    });
                }).catch(e => console.warn("[HW_WARN] Battery API access denied."));
            } else {
                console.log("[HW_INFO] Battery Status API not supported on this browser.");
            }
        },

        /**
         * Hardware Barometric Sensor initialization for micro-elevation data.
         */
        initBarometer: async () => {
            if (!("Barometer" in window)) {
                console.log("[HW_INFO] Environmental Barometer API not supported.");
                return;
            }
            try {
                const baroSensor = new Barometer({ frequency: 5 }); // 5Hz polling rate
                baroSensor.addEventListener("reading", () => {
                    if (AppState.hardware.baroBaseline === null) {
                        AppState.hardware.baroBaseline = baroSensor.pressure;
                    }
                    AppState.hardware.currentPressure = baroSensor.pressure;
                    AppState.hardware.pressureHistory.push(baroSensor.pressure);
                    
                    // Maintain a strict window size for the smoothing array
                    if (AppState.hardware.pressureHistory.length > AltiguardConfig.PHYSICS.SMOOTHING_FACTOR) {
                        AppState.hardware.pressureHistory.shift();
                    }
                });
                baroSensor.start();
                console.log("[HW_SYS] High-Frequency Barometer initialized.");
            } catch (e) { 
                console.warn("[HW_WARN] Barometer initialization rejected or unavailable."); 
            }
        },

        /**
         * Converts raw HPa differential into altitude meters utilizing moving averages.
         */
        calculateSmoothedAltitudeDelta: () => {
            if (AppState.hardware.pressureHistory.length > 0 && AppState.hardware.baroBaseline !== null) {
                const smoothedPressure = Utils.calculateMovingAverage(AppState.hardware.pressureHistory, AltiguardConfig.PHYSICS.SMOOTHING_FACTOR);
                // Standard Hypsometric Formula
                return 44330 * (1 - Math.pow(smoothedPressure / AppState.hardware.baroBaseline, 1 / 5.255));
            }
            return null;
        }
    };

    // ======================================================================================
    // 6. NOTIFICATION QUEUE SYSTEM
    // ======================================================================================
    const AlertSystem = {
        queue: [],
        isProcessing: false,

        /**
         * Adds an alert to the queue and starts processing if idle.
         */
        enqueue: (message, type = 'info') => {
            AlertSystem.queue.push({ message, type });
            if (!AlertSystem.isProcessing) {
                AlertSystem.processNext();
            }
        },

        /**
         * Processes the next alert in the queue.
         */
        processNext: () => {
            if (AlertSystem.queue.length === 0) {
                AlertSystem.isProcessing = false;
                const banner = document.getElementById("alertBanner");
                if (banner) banner.classList.remove("show");
                return;
            }

            AlertSystem.isProcessing = true;
            const currentAlert = AlertSystem.queue.shift();
            
            const banner = document.getElementById("alertBanner");
            if (banner) {
                banner.innerHTML = currentAlert.message;
                
                // Styling based on severity
                if (currentAlert.type === 'critical') {
                    banner.style.background = "linear-gradient(90deg, #be123c, #881337)";
                    banner.style.boxShadow = "0 10px 30px rgba(190, 18, 60, 0.8)";
                } else if (currentAlert.type === 'warning') {
                    banner.style.background = "linear-gradient(90deg, #f59e0b, #d97706)";
                    banner.style.boxShadow = "0 10px 30px rgba(245, 158, 11, 0.6)";
                } else {
                    banner.style.background = "linear-gradient(90deg, #14b8a6, #0f766e)";
                    banner.style.boxShadow = "0 10px 30px rgba(20, 184, 166, 0.5)";
                }

                banner.classList.add("show");
                
                // Hold banner on screen, then fade out and process next
                setTimeout(() => {
                    banner.classList.remove("show");
                    setTimeout(() => {
                        AlertSystem.processNext();
                    }, 500); // Wait for CSS transition to finish before showing next
                }, 5000);
            }
        },

        /**
         * Triggers the global site red-alert state (UI pulsing).
         */
        triggerSiteWideAlarm: () => {
            AppState.kinematics.isAlerting = true; 
            clearTimeout(AppState.kinematics.alertTimeoutId); 
            Renderer.renderSummary(); 
            
            AppState.kinematics.alertTimeoutId = setTimeout(() => { 
                AppState.kinematics.isAlerting = false; 
                Renderer.renderSummary(); 
            }, AltiguardConfig.NETWORK.ALERT_DURATION_MS); 
        }
    };

    // ======================================================================================
    // 7. WEBGL MAPPING ENGINE (LEAFLET)
    // ======================================================================================
    const MapEngine = {
        /**
         * Boots the WebGL mapping engine and sets up layer groups.
         */
        init: () => {
            const mapContainer = document.getElementById("map");
            if (!mapContainer || typeof L === "undefined") {
                console.error("[MAP_ERR] Leaflet library missing. Aborting visual topography.");
                return;
            }

            try {
                AppState.ui.mapInstance = L.map('map', { 
                    zoomControl: true, 
                    maxZoom: AltiguardConfig.MAP.MAX_ZOOM 
                }).setView([AltiguardConfig.MAP.DEFAULT_LAT, AltiguardConfig.MAP.DEFAULT_LON], AltiguardConfig.MAP.DEFAULT_ZOOM);
                
                L.tileLayer(AltiguardConfig.MAP.TILE_URL, { 
                    attribution: AltiguardConfig.MAP.ATTRIBUTION,
                    maxZoom: AltiguardConfig.MAP.MAX_ZOOM 
                }).addTo(AppState.ui.mapInstance);

                AppState.ui.traceLayer = L.layerGroup().addTo(AppState.ui.mapInstance);

                // Context Menu: Right-Click to Draw Geofence
                AppState.ui.mapInstance.on('contextmenu', (e) => {
                    if (AppState.identity.role === "creator" || AppState.identity.role === "sub-admin") {
                        AppState.network.socket.emit('addZone', { lat: e.latlng.lat, lon: e.latlng.lng, radius: 50 });
                        AlertSystem.enqueue("🗺️ Danger Zone Executed (50m Radius)", "info");
                    } else {
                        AlertSystem.enqueue("⚠️ Access Denied: Administrator clearance required to establish Danger Zones.", "warning");
                    }
                });

                console.log("[MAP_SYS] Geographic module online.");
            } catch(e) { 
                console.error("[MAP_ERR] Initialization failed.", e); 
            } 
        },

        /**
         * Syncs Leaflet DOM elements to internal state arrays.
         */
        render: () => {
            if (!AppState.ui.mapInstance || typeof L === "undefined") return; 
            
            const currentIds = AppState.telemetry.group.map(p => p.id); 
            
            // 1. Cleanup orphaned markers (users who left)
            for (let id in AppState.ui.mapMarkers) { 
                if (!currentIds.includes(id)) { 
                    AppState.ui.mapInstance.removeLayer(AppState.ui.mapMarkers[id]); 
                    delete AppState.ui.mapMarkers[id]; 
                } 
            } 
            
            // 2. Plot Active Nodes
            AppState.telemetry.group.forEach(p => { 
                if (p.lat && p.lon) { 
                    if (AppState.ui.mapMarkers[p.id]) {
                        AppState.ui.mapMarkers[p.id].setLatLng([p.lat, p.lon]); 
                    } else {
                        const iconColor = p.id === AppState.hardware.liveTrackingId ? AltiguardConfig.UI.COLORS.AMBER : AltiguardConfig.UI.COLORS.TEAL;
                        const tacticalIcon = L.divIcon({
                            className: 'tactical-marker',
                            html: `<svg width="24" height="24" viewBox="0 0 24 24" fill="${iconColor}"><circle cx="12" cy="12" r="10" stroke="#000" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="#000"/></svg>`,
                            iconSize: [24, 24],
                            iconAnchor: [12, 12]
                        });
                        
                        AppState.ui.mapMarkers[p.id] = L.marker([p.lat, p.lon], { icon: tacticalIcon })
                            .addTo(AppState.ui.mapInstance)
                            .bindPopup(`<div style="font-family:monospace; color:#000;"><b>ID:</b> ${p.id}<br><b>Operator:</b> ${Utils.escapeHtml(p.name)}<br><b>Z:</b> ${p.height.toFixed(2)}m</div>`); 
                    }
                } 
            }); 

            // 3. Paint Geofences
            AppState.ui.zoneLayers.forEach(layer => AppState.ui.mapInstance.removeLayer(layer)); 
            AppState.ui.zoneLayers = [];
            
            AppState.telemetry.dangerZones.forEach(z => {
                const circle = L.circle([z.lat, z.lon], { 
                    color: AltiguardConfig.UI.COLORS.RED, 
                    fillColor: AltiguardConfig.UI.COLORS.RED, 
                    fillOpacity: 0.3, 
                    radius: z.radius, 
                    weight: 2 
                }).addTo(AppState.ui.mapInstance);
                
                circle.bindPopup("<b style='color:red; font-family:sans-serif;'>⚠️ RESTRICTED DANGER ZONE</b>"); 
                AppState.ui.zoneLayers.push(circle);
            });

            // 4. Draw Selected Trace (Breadcrumbs)
            if (AppState.ui.traceLayer) {
                AppState.ui.traceLayer.clearLayers();
                if (AppState.telemetry.tracedTargetId && AppState.telemetry.traces[AppState.telemetry.tracedTargetId]) {
                    const pathData = AppState.telemetry.traces[AppState.telemetry.tracedTargetId];
                    if (pathData.length > 1) {
                        const path = pathData.map(t => [t.lat, t.lon]);
                        const polyline = L.polyline(path, { 
                            color: AltiguardConfig.UI.COLORS.BLUE, 
                            weight: 4, 
                            opacity: 0.9, 
                            dashArray: '10, 10' 
                        }).addTo(AppState.ui.traceLayer);
                        
                        // Optional: Auto-fit map to the trace if requested
                        // AppState.ui.mapInstance.fitBounds(polyline.getBounds(), { padding: [50, 50] });
                    }
                }
            }
        }
    };

    // ======================================================================================
    // 8. KINEMATICS, PHYSICS & GEOFENCING LOGIC
    // ======================================================================================
    const KinematicsEngine = {
        /**
         * Calculates status string based on relative height against thresholds.
         */
        evalThresholdStatus: (relHeight) => { 
            return relHeight > SystemSettings.limit ? "above" : relHeight < -SystemSettings.limit ? "below" : "within"; 
        },

        /**
         * Checks if a worker's trajectory intersects a registered danger zone.
         */
        assessGeofenceBreach: (person) => {
            if (!person.lat || !person.lon || !AppState.ui.mapInstance || typeof L === "undefined") return;
            
            let isCurrentlyInAnyZone = false;

            AppState.telemetry.dangerZones.forEach(z => {
                const dist = AppState.ui.mapInstance.distance([person.lat, person.lon], [z.lat, z.lon]);
                if (dist < z.radius) {
                    isCurrentlyInAnyZone = true;
                    if (!person.inZone) {
                        person.inZone = true; 
                        AppState.network.socket.emit('logIncident', `⚠️ SECTOR BREACH: ${person.name} entered restricted coordinates.`);
                        AlertSystem.enqueue(`⚠️ SECTOR BREACH: ${person.name} penetrated Danger Zone!`, 'critical'); 
                        FeedbackEngine.triggerTacticalBeep(); 
                        FeedbackEngine.triggerWarningVibe();
                    }
                }
            });

            // Clear flag if they left all zones
            if (!isCurrentlyInAnyZone && person.inZone) {
                person.inZone = false;
                AppState.network.socket.emit('logIncident', `✅ SECTOR CLEAR: ${person.name} exited Danger Zone.`);
            }
        },

        /**
         * Master Fall Detection Algorithm.
         * Analyzes rolling history window to detect severe kinematic drops.
         */
        assessKinematicDrop: (person) => {
            const now = Date.now(); 
            AppState.kinematics.history.push({ t: now, h: person.height });
            
            // Rolling Window Garbage Collection
            const windowMs = SystemSettings.dropWindow * 1000; 
            AppState.kinematics.history = AppState.kinematics.history.filter(r => now - r.t <= windowMs + 2000);
            
            // Isolate current active window
            const inWindow = AppState.kinematics.history.filter(r => now - r.t <= windowMs); 
            if (inWindow.length < 2) return;
            
            const peak = Math.max(...inWindow.map(r => r.h)); 
            const drop = peak - person.height;
            
            if (drop >= SystemSettings.dropThreshold) { 
                ActionControllers.executeEmergencyDropProtocol(person, drop, false); 
                // Reset filter to prevent double-firing from the same event
                AppState.kinematics.history = [{ t: now, h: person.height }]; 
            }
        }
    };

    // ======================================================================================
    // 9. ACTION CONTROLLERS & OUTBOUND NETWORK LOGIC
    // ======================================================================================
    const ActionControllers = {
        /**
         * Executes internal alerts and outbound REST hooks when a drop is detected.
         */
        executeEmergencyDropProtocol: (person, dropAmount, isTest) => {
            const topicInput = document.getElementById("ntfyTopicInput"); 
            const activeTopic = topicInput ? topicInput.value.trim() : (SystemSettings.ntfyTopic || "");
            
            const entry = { 
                id: Utils.generateUid(), 
                name: person ? person.name : "System Diagnostic Test", 
                drop: Number(dropAmount.toFixed(2)), 
                lat: person ? person.lat : null, 
                lon: person ? person.lon : null, 
                time: new Date().toISOString(), 
                test: !!isTest, 
                ntfyTopic: activeTopic 
            };
            
            if (!isTest) {
                AppState.network.socket.emit('logIncident', `⚠️ KINEMATIC ANOMALY: ${entry.name} dropped ${entry.drop}m.`);
                AppState.network.socket.emit('triggerAlert', entry); 
            }
            
            AlertSystem.triggerSiteWideAlarm(); 
            AlertSystem.enqueue(`⚠️ STRUCTURAL WARNING — ${entry.name} dropped ${entry.drop} m`, 'critical'); 
            FeedbackEngine.triggerSOSPattern(); 
            FeedbackEngine.triggerTacticalBeep();
            
            // Outbound Anonymous Push via Ntfy.sh
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
        },

        /**
         * Transmits a manual SOS to all connected peers.
         */
        transmitCriticalSOS: () => {
            if (!AppState.identity.personId) {
                return AlertSystem.enqueue("Action Rejected: You must join the grid before issuing an SOS.", "warning");
            }
            
            const me = AppState.telemetry.group.find(p => p.id === AppState.identity.personId);
            if (me) {
                AppState.network.socket.emit('triggerSOS', { name: me.name, lat: me.lat, lon: me.lon, height: me.height });
                
                // Outbound Push Notification
                const activeTopic = document.getElementById("ntfyTopicInput")?.value.trim() || SystemSettings.ntfyTopic;
                if (activeTopic) {
                    const clean = activeTopic.replace(/[^a-zA-Z0-9-_]/g, "");
                    fetch(`https://ntfy.sh/${clean}`, { 
                        method: 'POST', 
                        body: `🚨 CRITICAL SOS BY ${me.name} 🚨`, 
                        headers: { 'Title': 'Altiguard SOS', 'Priority': 'urgent', 'Tags': 'sos,rotating_light,skull' } 
                    }).catch(()=>{});
                }
            }
        },

        /**
         * Admins trigger this to send an evacuation waypoint to all clients.
         */
        transmitGlobalEvacuation: () => {
            if (AppState.telemetry.group.length === 0) {
                return AlertSystem.enqueue("Matrix empty. No nodes available to receive broadcast.", "warning");
            }
            
            const target = AppState.telemetry.group.find(p => p.id === AppState.telemetry.tracedTargetId) || 
                           AppState.telemetry.group.find(p => p.id === AppState.hardware.liveTrackingId) || 
                           AppState.telemetry.group[0];
                           
            AppState.network.socket.emit('broadcastEmergencyLocation', { 
                role: AppState.identity.role, 
                name: target.name, 
                height: target.height, 
                lat: target.lat, 
                lon: target.lon 
            });
            AlertSystem.enqueue(`🚨 Broadcast transmitted for ${target.name}.`, "info");
        },

        /**
         * Compiles current telemetry into a CSV and triggers browser download.
         */
        buildComplianceCSV: () => {
            if (AppState.identity.role !== "creator" && AppState.identity.role !== "sub-admin") return;
            
            let csv = "ALTIGUARD ENTERPRISE COMPLIANCE REPORT\nDate,Time,Category,Identity/Metric,Status\n";
            const dateStr = new Date().toLocaleDateString();
            
            csv += `\n--- ACTIVE PERSONNEL ROSTER ---\n`;
            AppState.telemetry.group.forEach(p => {
                csv += `${dateStr},--,PERSONNEL,ID: ${p.id} | Name: ${p.name},Max Z: ${p.height.toFixed(2)}m | Battery: ${p.battery}%\n`;
            });
            
            csv += `\n--- KERNEL INCIDENT LOGS ---\n`;
            AppState.telemetry.logs.forEach(l => { 
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
        },

        /**
         * Starts polling the HTML5 Geolocation API and broadcasting results.
         */
        activateLiveTelemetry: () => {
            if (!navigator.geolocation) {
                return AlertSystem.enqueue("HW_ERR: Geolocation not supported on this device.", "critical");
            }
            
            ActionControllers.haltLiveTelemetry(); 
            FeedbackEngine.unlockAudio(); 
            AppState.hardware.liveTrackingId = AppState.identity.personId;
            
            AppState.hardware.watchId = navigator.geolocation.watchPosition(
                (pos) => {
                    const person = AppState.telemetry.group.find(p => p.id === AppState.hardware.liveTrackingId); 
                    if (!person) { ActionControllers.haltLiveTelemetry(); return; }
                    
                    const { latitude, longitude, altitude, accuracy } = pos.coords;
                    let height = altitude ?? person.height ?? 0;
                    
                    // Sensor Fusion
                    const baroDelta = SensorEngine.calculateSmoothedAltitudeDelta();
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
                    person.battery = AppState.hardware.batteryLevel; 
                    person.updatedAt = new Date().toISOString();
                    
                    KinematicsEngine.assessKinematicDrop(person); 
                    KinematicsEngine.assessGeofenceBreach(person); 
                    
                    if (AppState.network.isConnected) {
                        AppState.network.socket.emit('updateGroup', AppState.telemetry.group);
                    }
                    
                    Renderer.executeDOMRender();
                }, 
                (err) => AlertSystem.enqueue(`GPS Error: ${err.message}`, "warning"), 
                { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
            );
            Renderer.executeDOMRender();
        },

        /**
         * Stops polling Geolocation.
         */
        haltLiveTelemetry: () => {
            if (AppState.hardware.watchId !== null) { 
                navigator.geolocation.clearWatch(AppState.hardware.watchId); 
                AppState.hardware.watchId = null; 
            } 
            AppState.hardware.liveTrackingId = null; 
            Renderer.executeDOMRender();
        }
    };

    // ======================================================================================
    // 10. RENDERING ENGINE & DOM MANIPULATION
    // ======================================================================================
    const Renderer = {
        /**
         * Main render loop.
         */
        executeDOMRender: () => {
            Renderer.renderSummary();
            Renderer.renderRoster();
            Renderer.renderPhysicsGraph();
            MapEngine.render();
        },

        /**
         * Updates top statistics bar.
         */
        renderSummary: () => {
            const elActive = document.getElementById("statActive");
            const elStatus = document.getElementById("statStatus");
            if (!elActive || !elStatus) return; 
            
            elActive.textContent = `${AppState.telemetry.group.length} Active Nodes`;
            
            if (AppState.kinematics.isAlerting) { 
                elStatus.className = "status-danger"; 
                elStatus.innerHTML = "🔴 KINEMATIC ANOMALY DETECTED"; 
            } else { 
                elStatus.className = "status-secure"; 
                elStatus.innerHTML = AppState.network.isConnected ? "🟢 SYSTEM NOMINAL" : "🔴 UPLINK SEVERED"; 
            }
        },

        /**
         * Updates the list of active users, handling role-based HTML generation.
         */
        renderRoster: () => {
            const list = document.getElementById("rosterList");
            const emptyHint = document.getElementById("emptyHint");
            if (!list || !emptyHint) return; 
            
            if (AppState.telemetry.group.length === 0) { 
                list.innerHTML = ""; 
                emptyHint.style.display = "block"; 
                return; 
            }
            
            emptyHint.style.display = "none"; 

            list.innerHTML = AppState.telemetry.group.map((p) => {
                const rel = p.height - AppState.telemetry.globalReference;
                const status = KinematicsEngine.evalThresholdStatus(rel);
                const isSelf = p.id === AppState.identity.personId;
                
                // Iconography
                const roleIcon = p.role === 'creator' ? '👑' : p.role === 'sub-admin' ? '⭐' : '👷';
                const batColor = p.battery < 20 ? AltiguardConfig.UI.COLORS.RED : AltiguardConfig.UI.COLORS.TEAL;
                const batStr = p.battery ? `<span style="color:${batColor}; font-size:11px; margin-left:10px; border:1px solid rgba(255,255,255,0.2); padding:3px 8px; border-radius:6px; font-family:var(--font-data);">🔋${p.battery}%</span>` : "";
                
                // Permission Booleans
                const canRemove = (AppState.identity.role === "creator") || (AppState.identity.role === "sub-admin" && p.role !== "creator") || isSelf;
                const canPromote = (AppState.identity.role === "creator") && !isSelf;

                // Action Buttons Generation
                let actions = "";
                if (isSelf) {
                    const isTrackingSelf = AppState.hardware.liveTrackingId === p.id;
                    actions += `<button class="mini-btn track-btn ${isTrackingSelf ? "active" : ""}" data-id="${p.id}">${isTrackingSelf ? "⏹ Halt GPS Uplink" : "📍 Transmit Live GPS"}</button>`;
                }
                if (AppState.identity.role === "creator" || AppState.identity.role === "sub-admin") {
                    const isTraced = AppState.telemetry.tracedTargetId === p.id;
                    actions += `<button class="mini-btn trace-btn ${isTraced ? "active" : ""}" data-id="${p.id}">🗺️ ${isTraced ? "Hide Trace" : "Trace Route (5m)"}</button>`;
                }
                if (canPromote) {
                    if (p.role === 'worker') {
                        actions += `<button class="mini-btn promote-btn" data-id="${p.id}" style="color:var(--warning); border-color:var(--warning);">⭐ Grant Admin</button>`;
                    } else if (p.role === 'sub-admin') {
                        actions += `<button class="mini-btn demote-btn" data-id="${p.id}">⬇️ Revoke Admin</button>`;
                    }
                }
                if (canRemove) {
                    actions += `<button class="mini-btn remove-btn" data-id="${p.id}" style="color:var(--danger); border-color:rgba(239,68,68,0.4);">${isSelf && AppState.identity.role !== 'creator' ? '✕ Disconnect' : '✕ Eject Node'}</button>`;
                }

                // Determine display method
                let methodLabel = p.method === "barometer" ? "Baro Array" : p.method === "gps" ? "Sat GPS" : p.method === "manual" ? "Manual Input" : "Unknown";

                return `
                <li class="roster-item ${p.inZone ? "zone-breach" : ""}">
                    <div class="roster-info">
                        <strong>${roleIcon} ${Utils.escapeHtml(p.name)} ${isSelf ? `<small style="color:var(--info); font-family:var(--font-data); font-size:10px;">(THIS DEVICE)</small>` : ''} ${batStr}</strong>
                        <span class="roster-sub">Z: ${p.height.toFixed(2)}m · Data Source: ${methodLabel}</span>
                    </div>
                    <div class="roster-status status-${status}">${Utils.fmtSigned(rel, 2)} m<small>STATUS: ${status.toUpperCase()}</small></div>
                    <div class="roster-actions">${actions}</div>
                </li>`;
            }).join("");
        },

        /**
         * Re-draws the log feed based on internal server array.
         */
        renderSystemLogs: () => {
            const list = document.getElementById("logList"); 
            if (!list) return; 
            
            list.innerHTML = AppState.telemetry.logs.slice(0, 30).map(a => {
                const isErr = a.type === 'ALERT' || a.type === 'SOS' || a.type === 'FALL_DETECT';
                const isWarn = a.type === 'GEOFENCE' || a.type === 'BROADCAST';
                const cls = isErr ? 'error' : isWarn ? 'warning' : 'success';
                return `<li class="log-item ${cls}"><span class="log-time">${new Date(a.time).toLocaleTimeString()}</span><span class="log-text"><strong>[${a.type}]</strong> ${Utils.escapeHtml(a.message)}</span></li>`;
            }).join(""); 
        },

        /**
         * Advanced SVG drawing function. Creates dynamic axes, clipping paths, and architectural grid lines.
         */
        renderPhysicsGraph: () => {
            const svg = document.getElementById("graphSvg"); 
            if (!svg) return;
            
            if (AppState.telemetry.group.length === 0) {
                svg.innerHTML = `<text x="50%" y="50%" fill="var(--text-med)" text-anchor="middle" font-family="monospace">NO PERSONNEL GEOMETRY DETECTED</text>`;
                return;
            }

            const W = 640, H = 420, marginL = 58, marginR = 20, marginT = 20, marginB = 46;
            const plotW = W - marginL - marginR, plotH = H - marginT - marginB;
            const midY = marginT + plotH / 2;
            
            const rels = AppState.telemetry.group.map(p => p.height - AppState.telemetry.globalReference); 
            const maxAbs = Math.max(SystemSettings.limit * 1.2, ...rels.map(r => Math.abs(r)), 1); 
            const scale = (plotH / 2) / maxAbs; 
            const parts = [];
            
            // 1. Draw Architectural Floor Bands (Background)
            const floorH = SystemSettings.floorHeight || 3.5;
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
            
            // 2. Draw Personnel SVG Geometry
            AppState.telemetry.group.forEach((p, i) => { 
                const rel = p.height - AppState.telemetry.globalReference;
                const x = marginL + (plotW * (i + 0.5)) / AppState.telemetry.group.length;
                const y = midY - rel * scale; 
                const status = KinematicsEngine.evalThresholdStatus(rel);
                const isLive = p.id === AppState.hardware.liveTrackingId;
                
                const cls = `figure figure-${status}${isLive ? " figure-live" : ""}`; 
                
                parts.push(`
                    <g class="${cls}" data-person-id="${p.id}" style="--fx: ${x.toFixed(1)}px; --fy: ${y.toFixed(1)}px;">
                        ${isLive ? '<circle class="live-halo" r="14"></circle>' : ""}
                        <text class="figure-readout" x="0" y="-28" text-anchor="middle">${Utils.fmtSigned(rel, 2)}m</text>
                        <circle class="figure-head" cx="0" cy="-14" r="6"></circle>
                        <line class="figure-body" x1="0" y1="-8" x2="0" y2="10"></line>
                        <line class="figure-arm" x1="0" y1="-3" x2="-9" y2="6"></line>
                        <line class="figure-arm" x1="0" y1="-3" x2="9" y2="6"></line>
                        <line class="figure-leg" x1="0" y1="10" x2="-8" y2="25"></line>
                        <line class="figure-leg" x1="0" y1="10" x2="8" y2="25"></line>
                        <text class="figure-label" x="0" y="39" text-anchor="middle">${Utils.escapeHtml(p.name)}</text>
                    </g>
                `); 
            });
            
            // 3. Draw Mathematics Grid Lines
            const step = Utils.calculateNiceStep(maxAbs);
            for (let v = step; v <= maxAbs; v += step) {
                [v, -v].forEach(val => {
                    const y = midY - val * scale; 
                    if (y >= marginT && y <= marginT + plotH) {
                        parts.push(`<line class="grid-line" x1="${marginL}" y1="${y}" x2="${marginL + plotW}" y2="${y}"></line>`);
                        parts.push(`<text class="axis-label" x="${marginL - 8}" y="${y + 3}" text-anchor="end">${val > 0 ? "+" : ""}${val}</text>`);
                    }
                });
            }
            
            // 4. Base Datum Line
            parts.push(`<line class="baseline" x1="${marginL}" y1="${midY}" x2="${marginL + plotW}" y2="${midY}"></line>`);
            parts.push(`<text class="baseline-label" x="${marginL + plotW}" y="${midY - 8}" text-anchor="end">DATUM ZERO</text>`);
            parts.push(`<text class="axis-label" x="${marginL - 8}" y="${midY + 3}" text-anchor="end">0</text>`);
            
            svg.innerHTML = parts.join("");
        },

        /**
         * Visually updates role permissions UI.
         */
        updateRoleUI: () => {
            const roleBadge = document.getElementById("statRole"); 
            if (roleBadge) roleBadge.textContent = AppState.identity.role.toUpperCase();
            
            const ctrl = document.getElementById("adminControls");
            if (ctrl) {
                ctrl.style.display = (AppState.identity.role === "creator" || AppState.identity.role === "sub-admin") ? "flex" : "none";
            }
            
            const mapContainer = document.getElementById("map");
            if (mapContainer && (AppState.identity.role === "creator" || AppState.identity.role === "sub-admin") && !document.getElementById("mapDrawHint")) {
                const hint = document.createElement("div"); 
                hint.id = "mapDrawHint";
                hint.innerHTML = "🗺️ <i>TACTICAL CONTROLS: Right-Click Map to paint Danger Zone.</i>";
                
                Object.assign(hint.style, {
                    position: "absolute", bottom: "10px", left: "10px", zIndex: "999", 
                    background: "rgba(0,0,0,0.8)", color: "var(--warning)", padding: "8px 12px", 
                    fontSize: "11px", borderRadius: "6px", fontFamily: "var(--font-data)"
                });
                
                const clearBtn = document.createElement("button"); 
                clearBtn.innerHTML = "Purge Zones"; 
                
                Object.assign(clearBtn.style, {
                    marginLeft: "15px", background: "var(--danger)", color: "#fff", 
                    border: "none", padding: "4px 8px", cursor: "pointer", 
                    borderRadius: "4px", fontWeight: "bold"
                });
                
                clearBtn.onclick = () => AppState.network.socket.emit('clearZones');
                hint.appendChild(clearBtn); 
                mapContainer.appendChild(hint);
            }
        }
    };


    // ======================================================================================
    // 11. DYNAMIC DOM GENERATION (SCAFFOLDING)
    // ======================================================================================
    /**
     * Builds and injects missing structural HTML components into the DOM using
     * raw Document Object Model API methods to ensure absolute cross-browser compatibility.
     */
    function scaffoldDOM() {
        const body = document.body;
        const main = document.querySelector("main") || body;

        // 1. Group Control Matrix
        if (!document.getElementById("groupControlWrapper")) {
            const joinBtn = document.getElementById("joinRoomBtn"); 
            if (joinBtn) {
                const wrapper = document.createElement("div"); 
                wrapper.id = "groupControlWrapper"; 
                wrapper.className = "group-control-row";
                
                const createBtn = document.createElement("button");
                createBtn.id = "createGroupBtn";
                createBtn.className = "primary-btn";
                createBtn.textContent = "Initialize Site Matrix";
                
                const connectBtn = document.createElement("button");
                connectBtn.id = "joinGroupActionBtn";
                connectBtn.className = "outline-btn";
                connectBtn.textContent = "Connect Node";
                
                wrapper.appendChild(createBtn);
                wrapper.appendChild(connectBtn);
                
                joinBtn.parentNode.insertBefore(wrapper, joinBtn); 
                joinBtn.style.display = "none"; 
                
                createBtn.addEventListener("click", () => {
                    const code = document.getElementById("groupCodeInput")?.value.trim();
                    AppState.network.socket.emit('createGroup', code);
                });
                connectBtn.addEventListener("click", () => {
                    const code = document.getElementById("groupCodeInput")?.value.trim();
                    if (!code) return AlertSystem.enqueue("Input required: Provide Site Access Code.", "warning");
                    AppState.network.socket.emit('joinGroup', code);
                });
            }
        }

        // 2. Summary Telemetry HUD
        if (!document.getElementById("summaryBar")) {
            const bar = document.createElement("div"); 
            bar.id = "summaryBar"; 
            bar.className = "summary-bar";
            
            const buildStatBox = (label, id, initialVal, cls = "") => {
                return `<div class="stat-box"><span class="stat-label">${label}</span><strong id="${id}" class="${cls}">${initialVal}</strong></div>`;
            };
            
            bar.innerHTML = buildStatBox("Clearance Role", "statRole", "SYS_BOOT") + 
                            buildStatBox("Active Nodes", "statActive", "0 Tracked") + 
                            buildStatBox("Command Uplink", "statStatus", "CONNECTING", "status-secure");
                            
            if(main) main.insertBefore(bar, main.firstChild);
        }

        // 3. Admin Tactical Controls (Hidden initially)
        if (!document.getElementById("adminControls")) {
            const ctrl = document.createElement("div"); 
            ctrl.id = "adminControls"; 
            ctrl.className = "admin-controls-row"; 
            ctrl.style.display = "none"; 
            
            const bBtn = document.createElement("button");
            bBtn.id = "emergencyBroadcastBtn";
            bBtn.className = "emergency-broadcast-btn";
            bBtn.textContent = "🚨 Transmit Global Evac";
            
            const eBtn = document.createElement("button");
            eBtn.id = "exportCsvBtn";
            eBtn.className = "export-btn";
            eBtn.textContent = "📊 Compile Compliance Log";
            
            ctrl.appendChild(bBtn);
            ctrl.appendChild(eBtn);
            
            if(main) main.insertBefore(ctrl, main.children[1] || null);
            
            bBtn.addEventListener("click", ActionControllers.transmitGlobalEvacuation);
            eBtn.addEventListener("click", ActionControllers.buildComplianceCSV);
        }

        // 4. Overlays & Banners
        const overlays = [
            { id: "sosTriggerBtn", type: "button", text: "🚨 INITIATE SOS", handler: ActionControllers.transmitCriticalSOS },
            { id: "sosAlertBanner", type: "div" },
            { id: "alertBanner", type: "div" }
        ];

        overlays.forEach(item => {
            if (!document.getElementById(item.id)) {
                const el = document.createElement(item.type);
                el.id = item.id;
                if (item.text) el.innerHTML = item.text;
                if (item.handler) el.onclick = item.handler;
                body.appendChild(el);
            }
        });

        // 5. Advanced Gemini AI Module Widget
        if (!document.getElementById("aiAdvisorBtn")) {
            const aiBtn = document.createElement("button"); 
            aiBtn.id = "aiAdvisorBtn"; 
            aiBtn.innerHTML = "✨ Execute AI Audit";
            
            Object.assign(aiBtn.style, { 
                position: "fixed", bottom: "30px", left: "30px", zIndex: "9999", 
                background: "linear-gradient(135deg, var(--primary), var(--info))", color: "#000", 
                border: "none", padding: "12px 20px", borderRadius: "30px", 
                fontFamily: "var(--font-heading)", fontWeight: "bold", fontSize: "14px", 
                cursor: "pointer", boxShadow: "0 0 20px rgba(20, 184, 166, 0.4)" 
            });
            
            const aiModal = document.createElement("div"); 
            aiModal.id = "aiModal";
            Object.assign(aiModal.style, { 
                position: "fixed", bottom: "80px", left: "30px", zIndex: "9998", 
                background: "rgba(13, 19, 33, 0.95)", backdropFilter: "blur(10px)", 
                border: "1px solid var(--primary)", borderRadius: "var(--radius-lg)", 
                padding: "20px", width: "350px", color: "var(--text-high)", 
                fontFamily: "var(--font-ui)", fontSize: "13px", lineHeight: "1.6", 
                boxShadow: "0 10px 40px rgba(0,0,0,0.6)", display: "none", 
                transform: "translateY(10px)", opacity: "0", transition: "all 0.3s ease" 
            });
            
            body.appendChild(aiBtn); 
            body.appendChild(aiModal);

            aiBtn.onclick = () => {
                if (AppState.telemetry.group.length === 0) { 
                    aiModal.innerHTML = "⚠️ AI Audit Aborted: No active personnel telemetry available."; 
                    revealModal(aiModal); 
                    return; 
                }
                
                aiBtn.innerHTML = "⏳ Structuring Prompt...";
                
                const h = Math.max(...AppState.telemetry.group.map(p => p.height - AppState.telemetry.globalReference)).toFixed(1);
                let lowBatCount = 0;
                AppState.telemetry.group.forEach(p => { if (p.battery && p.battery < 20) lowBatCount++; });

                AppState.network.socket.emit('requestAiInsight', { 
                    workerCount: AppState.telemetry.group.length, 
                    highestElevation: h, 
                    temperature: "Unknown", 
                    windSpeed: "Unknown", 
                    zonesCount: AppState.telemetry.dangerZones.length, 
                    lowBatteryCount: lowBatCount 
                });
            };

            AppState.network.socket.on('aiInsightResponse', (res) => {
                aiBtn.innerHTML = "✨ Execute AI Audit";
                aiModal.innerHTML = res.error 
                    ? `❌ <b>AI Offline:</b><br>${res.error}` 
                    : `<b style="color:var(--primary); font-family:var(--font-heading); font-size:16px;">🤖 GEMINI SAFETY ANALYSIS:</b><br><br>${res.result}`;
                revealModal(aiModal);
            });

            function revealModal(el) {
                el.style.display = "block"; 
                setTimeout(() => { el.style.transform = "translateY(0)"; el.style.opacity = "1"; }, 10);
                setTimeout(() => { el.style.transform = "translateY(10px)"; el.style.opacity = "0"; setTimeout(() => el.style.display="none", 300); }, 15000);
            }
        }

        // 6. Signature
        if (!document.getElementById("devCredit")) {
            const credit = document.createElement("div"); 
            credit.className = "dev-credit";
            credit.innerHTML = "ALTIGUARD // KERNEL V4.0 // ENGINEERED BY VAIBHAV RAJU KONDANE";
            body.appendChild(credit);
        }
    }


    // ======================================================================================
    // 12. SOCKET EVENT BINDINGS
    // ======================================================================================
    function bindNetworkEvents() {
        const ioSocket = AppState.network.socket;
        
        ioSocket.on('roleAssigned', ({ role, roomCode }) => {
            AppState.identity.role = role; 
            AppState.identity.roomCode = roomCode;
            const codeInput = document.getElementById("groupCodeInput"); 
            if (codeInput) codeInput.value = roomCode;
            
            AlertSystem.enqueue(`Connection Established. Clearance Level: ${role.toUpperCase()}`, "success");
            Renderer.updateRoleUI(); 
            Renderer.executeDOMRender();
        });

        ioSocket.on('groupError', (msg) => AlertSystem.enqueue(`⚠️ COMMAND ERROR: ${msg}`, "error"));
        
        ioSocket.on('syncReference', (ref) => { 
            AppState.telemetry.globalReference = ref; 
            const refIn = document.getElementById("referenceInput"); 
            if (refIn) refIn.value = ref; 
            Renderer.executeDOMRender(); 
        });
        
        ioSocket.on('syncLogs', (logs) => { 
            AppState.telemetry.logs = logs; 
            Renderer.renderSystemLogs(); 
        });
        
        ioSocket.on('syncZones', (zones) => {
            AppState.telemetry.dangerZones = zones;
            MapEngine.render();
        });

        ioSocket.on('syncGroup', (serverGroup) => {
            // Evaluate self permissions
            if (AppState.identity.personId) {
                const me = serverGroup.find(p => p.id === AppState.identity.personId);
                if (me && me.role !== AppState.identity.role && AppState.identity.role !== 'creator') {
                    AppState.identity.role = me.role; 
                    AlertSystem.enqueue(`Privilege Escalation: Clearance updated to ${AppState.identity.role.toUpperCase()}`, "info"); 
                    Renderer.updateRoleUI();
                }
            }
            
            AppState.telemetry.group = serverGroup;
            
            const now = Date.now();
            AppState.telemetry.group.forEach(p => {
                if (p.lat && p.lon) {
                    if (!AppState.telemetry.traces[p.id]) AppState.telemetry.traces[p.id] = [];
                    const last = AppState.telemetry.traces[p.id][AppState.telemetry.traces[p.id].length - 1];
                    
                    if (!last || Math.abs(last.lat - p.lat) > 0.00001 || Math.abs(last.lon - p.lon) > 0.00001) {
                        AppState.telemetry.traces[p.id].push({ lat: p.lat, lon: p.lon, time: now });
                    }
                    
                    AppState.telemetry.traces[p.id] = AppState.telemetry.traces[p.id].filter(t => now - t.time <= AltiguardConfig.PHYSICS.MAX_TRACE_AGE_MS); 
                }
            });
            
            Renderer.executeDOMRender();
        });

        ioSocket.on('receiveEmergencyBroadcast', (payload) => {
            FeedbackEngine.triggerHaptics(); 
            FeedbackEngine.triggerTacticalBeep();
            const coordsStr = (payload.lat && payload.lon) 
                ? `<br><a href="https://www.google.com/maps?q=${payload.lat},${payload.lon}" target="_blank" style="color:var(--amber); text-decoration:underline;">📍 INTERCEPT EVACUATION COORDS</a>` 
                : "";
            AlertSystem.enqueue(`🚨 COMMAND BROADCAST: Rally at ${Utils.escapeHtml(payload.name)} [Z: ${payload.height.toFixed(2)}m] ${coordsStr}`, "critical");
            
            if (AppState.ui.mapInstance && payload.lat && payload.lon) {
                AppState.ui.mapInstance.setView([payload.lat, payload.lon], 16);
            }
        });
        
        ioSocket.on('receiveAlert', (entry) => {
            AlertSystem.enqueue(`⚠️ KINEMATIC ALERT — ${entry.name} dropped ${entry.drop} m`, "critical");
            FeedbackEngine.triggerHaptics(); 
            FeedbackEngine.triggerTacticalBeep(); 
            
            const el = document.querySelector(`.figure[data-person-id="${entry.personId}"]`); 
            if (el) {
                el.classList.add("figure-flash"); 
                setTimeout(() => el.classList.remove("figure-flash"), 4000); 
            }
            AlertSystem.triggerSiteWideAlarm();
        });
    }

    // ======================================================================================
    // 13. MASTER BOOT SEQUENCE
    // ======================================================================================
    function initBootSequence() {
        console.log(`[SYS_BOOT] Altiguard Enterprise Client ${AltiguardConfig.VERSION} Initializing...`);
        
        scaffoldDOM();
        bindNetworkEvents();
        
        // 1. Bind Form Submission Logic
        const addForm = document.getElementById("addForm");
        if (addForm) {
            addForm.addEventListener("submit", (e) => {
                e.preventDefault(); 
                const nameEl = document.getElementById("nameInput"); 
                const name = nameEl ? nameEl.value.trim() : ""; 
                if (!name) return;
                
                const personId = Utils.generateUid(); 
                if (!AppState.identity.personId) AppState.identity.personId = personId;
                
                let method = "manual";
                let h = 0, l_lat = null, l_lon = null;
                
                const manH = document.getElementById("manualHeight");
                if (manH && manH.value !== "") {
                    h = parseFloat(manH.value);
                }

                const person = { 
                    id: personId, 
                    name, 
                    role: AppState.identity.role, 
                    battery: AppState.hardware.batteryLevel, 
                    inZone: false, 
                    height: h, 
                    lat: l_lat, 
                    lon: l_lon, 
                    method: method, 
                    updatedAt: new Date().toISOString() 
                };
                
                AppState.telemetry.group.push(person); 
                
                if (AppState.network.isConnected) {
                    AppState.network.socket.emit('updateGroup', AppState.telemetry.group);
                }
                
                // Reset View
                ["nameInput", "workerPhoneInput", "manualHeight", "manualLat", "manualLon"].forEach(id => { 
                    const el = document.getElementById(id); if (el) el.value = ""; 
                }); 
                
                Renderer.executeDOMRender();
            });
        }

        // 2. Bind Datum Calibrator
        const setRefBtn = document.getElementById("setRefBtn"); 
        if (setRefBtn) { 
            setRefBtn.addEventListener("click", () => { 
                const val = parseFloat(document.getElementById("referenceInput")?.value); 
                if (!isNaN(val)) { 
                    AppState.telemetry.globalReference = val; 
                    if (AppState.network.isConnected) AppState.network.socket.emit('updateReference', val); 
                    Renderer.executeDOMRender(); 
                } 
            }); 
        }
        
        const testAlertBtn = document.getElementById("testAlertBtn"); 
        if (testAlertBtn) testAlertBtn.addEventListener("click", () => ActionControllers.executeEmergencyDropProtocol(null, 1.80, true));

        // 3. Bind Event Delegation for Dynamic Roster Actions
        const rosterList = document.getElementById("rosterList");
        if (rosterList) {
            rosterList.addEventListener("click", (e) => {
                const id = e.target.dataset.id;
                if (!id) return;
                
                if (e.target.closest(".track-btn")) { 
                    if (AppState.hardware.liveTrackingId === id) ActionControllers.haltLiveTelemetry(); 
                    else ActionControllers.activateLiveTelemetry(); 
                } 
                else if (e.target.closest(".trace-btn")) { 
                    if (AppState.telemetry.tracedTargetId === id) AppState.telemetry.tracedTargetId = null; 
                    else AppState.telemetry.tracedTargetId = id; 
                    Renderer.executeDOMRender(); 
                }
                else if (e.target.closest(".remove-btn")) { 
                    if (AppState.hardware.liveTrackingId === id) ActionControllers.haltLiveTelemetry(); 
                    AppState.network.socket.emit('removeMember', { personId: id, requestedByPersonId: AppState.identity.personId, requesterRole: AppState.identity.role }); 
                }
                else if (e.target.closest(".promote-btn")) { 
                    const p = AppState.telemetry.group.find(x => x.id === id); 
                    if (p) { p.role = 'sub-admin'; if (AppState.network.isConnected) AppState.network.socket.emit('updateGroup', AppState.telemetry.group); } 
                }
                else if (e.target.closest(".demote-btn")) { 
                    const p = AppState.telemetry.group.find(x => x.id === id); 
                    if (p) { p.role = 'worker'; if (AppState.network.isConnected) AppState.network.socket.emit('updateGroup', AppState.telemetry.group); } 
                }
            });
        }

        // 4. Bind Settings Autosave
        const saveSettings = () => { 
            SystemSettings.limit = parseFloat(document.getElementById("limitInput")?.value) || AltiguardConfig.PHYSICS.DEFAULT_LIMIT; 
            SystemSettings.dropThreshold = parseFloat(document.getElementById("dropInput")?.value) || AltiguardConfig.PHYSICS.DEFAULT_DROP_THRESHOLD; 
            SystemSettings.dropWindow = parseInt(document.getElementById("windowInput")?.value, 10) || AltiguardConfig.PHYSICS.DEFAULT_DROP_WINDOW; 
            SystemSettings.ntfyTopic = document.getElementById("ntfyTopicInput")?.value.trim() || ""; 
            SystemSettings.floorHeight = parseFloat(document.getElementById("floorInput")?.value) || AltiguardConfig.PHYSICS.DEFAULT_FLOOR_HEIGHT; 
            Utils.Storage.save(AltiguardConfig.STORAGE_KEY, SystemSettings); 
            Renderer.executeDOMRender(); 
        };
        ["limitInput", "dropInput", "windowInput", "ntfyTopicInput", "floorInput"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener("input", saveSettings);
        });

        // 5. Init Subsystems
        MapEngine.init(); 
        SensorEngine.initBarometer(); 
        SensorEngine.initBatteryTelemetry();
        Renderer.executeDOMRender();
        
        console.log("[SYS_OK] All Altiguard Kernel Subsystems Operational.");
    }

    // Attach to standard DOM ready event
    document.addEventListener("DOMContentLoaded", initBootSequence);

})();
