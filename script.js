(function () {
    "use strict";

    const socket = io();
    let currentRole = "worker", currentGroupCode = null, mySelfId = null;
    let liveTrackingId = null, gpsWatchId = null;
    let group = [], logs = [], kinematicHistory = [];
    let globalBaseline = 0;
    let map = null, markers = {};

    const statRole = document.getElementById("statRole");
    const statActive = document.getElementById("statActive");
    const rosterList = document.getElementById("rosterList");
    const graphSvg = document.getElementById("graphSvg");
    const alertBanner = document.getElementById("alertBanner");

    // 1. SOCKET LISTENERS
    socket.on('roleAssigned', (data) => {
        currentRole = data.role; currentGroupCode = data.groupCode;
        statRole.textContent = currentRole.toUpperCase();
        document.getElementById("groupCodeInput").value = currentGroupCode;
        showAlert(`Connected to ${currentGroupCode} as ${currentRole.toUpperCase()}`);
        renderUI();
    });

    socket.on('syncGroup', (members) => { group = members; renderUI(); });
    socket.on('syncBaseline', (baseline) => { 
        globalBaseline = baseline; 
        document.getElementById("referenceInput").value = baseline; 
        renderUI(); 
    });

    socket.on('receiveAlert', (data) => { showAlert(`⚠️ ALERT: ${data.name} dropped ${data.drop}m!`); logEvent(`⚠️ Fall detected: ${data.name} (${data.drop}m)`); triggerBeep(); });
    socket.on('receiveSOS', (payload) => { showAlert(`🚨 SOS: ${payload.name} initiated an emergency!`); logEvent(`🚨 SOS Activated by ${payload.name}`); triggerBeep(); });

    // 2. DASHBOARD INTERACTIONS
    document.getElementById("createGroupBtn").addEventListener("click", () => socket.emit('createGroup', document.getElementById("groupCodeInput").value));
    document.getElementById("joinGroupActionBtn").addEventListener("click", () => {
        const code = document.getElementById("groupCodeInput").value;
        if (!code) return showAlert("Please enter a Site Code.");
        socket.emit('joinGroup', code);
    });

    document.getElementById("setRefBtn").addEventListener("click", () => {
        const val = parseFloat(document.getElementById("referenceInput").value) || 0;
        globalBaseline = val; 
        socket.emit('setBaseline', val);
        renderUI();
        showAlert(`Datum Zero calibrated to ${val}m`);
    });

    let isManual = false;
    let pendingLocation = null;
    document.getElementById("manualToggle").addEventListener("click", () => {
        isManual = !isManual;
        document.getElementById("manualFields").hidden = !isManual;
        document.getElementById("gpsReadout").hidden = true;
        document.getElementById("addBtn").disabled = false;
    });

    // -------------------------------------------------------------
    // WEATHER & AQI API (OPEN-METEO - FREE, NO KEY)
    // -------------------------------------------------------------
    async function fetchWeatherAndAQI(lat, lon) {
        try {
            // Weather
            const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
            const weatherData = await weatherRes.json();
            
            // AQI (Air Quality)
            const aqiRes = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=european_aqi`);
            const aqiData = await aqiRes.json();

            const temp = weatherData.current_weather.temperature;
            const wind = weatherData.current_weather.windspeed;
            const code = weatherData.current_weather.weathercode;
            const aqi = aqiData.current.european_aqi;

            document.getElementById("wTemp").innerText = `${temp}°C`;
            document.getElementById("wWind").innerText = `${wind} km/h`;
            
            // Render AQI Color Badge
            const aqiEl = document.getElementById("wAqi");
            aqiEl.innerText = aqi;
            aqiEl.className = "aqi-badge";
            if (aqi < 40) aqiEl.classList.add("aqi-good");
            else if (aqi < 80) aqiEl.classList.add("aqi-mod");
            else aqiEl.classList.add("aqi-poor");

            // Weather Animations Logic
            const iconBox = document.getElementById("weatherIconBox");
            const conditionEl = document.getElementById("wCondition");
            
            if (code === 0 || code === 1) {
                conditionEl.innerText = "Clear & Sunny";
                iconBox.innerHTML = `<div class="anim-sun"></div>`;
            } else if (code >= 51 && code <= 67) {
                conditionEl.innerText = "Rainy";
                iconBox.innerHTML = `<div class="anim-cloud anim-rain"></div>`;
            } else {
                conditionEl.innerText = "Cloudy / Overcast";
                iconBox.innerHTML = `<div class="anim-cloud"></div>`;
            }

        } catch (e) {
            console.error("Weather fetch failed", e);
        }
    }

    async function fetchAddress(lat, lon) {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`);
            const data = await res.json();
            if (data && data.address) {
                const addr = data.address;
                return `${addr.road || ''}, ${addr.city || addr.town || ''} - ${addr.postcode || ''}`;
            }
            return "Address unavailable";
        } catch(e) { return "Address unavailable"; }
    }

    document.getElementById("captureBtn").addEventListener("click", () => {
        const readout = document.getElementById("gpsReadout");
        readout.hidden = false;
        readout.innerHTML = `<div class="spinner" style="width:15px;height:15px;display:inline-block;vertical-align:middle;margin-right:10px;"></div> Acquiring Satellite Lock...`;

        navigator.geolocation.getCurrentPosition(async (pos) => {
            const lat = pos.coords.latitude;
            const lon = pos.coords.longitude;
            const alt = pos.coords.altitude || 0;
            
            readout.innerHTML = `Fetching precise address & climate data...`;
            const address = await fetchAddress(lat, lon);
            await fetchWeatherAndAQI(lat, lon); // Trigger Weather Module
            
            pendingLocation = { lat, lon, height: alt };

            readout.innerHTML = `
                <strong style="color:var(--brand-primary);">📍 Lock Acquired</strong><br>
                <span style="font-family:monospace; color:#ccc;">Coord: ${lat.toFixed(5)}, ${lon.toFixed(5)}</span><br>
                <span style="font-size:0.8rem; color:var(--text-muted);">${address}</span>
            `;
            
            document.getElementById("addBtn").disabled = false;
            isManual = false;
            document.getElementById("manualFields").hidden = true;
        }, (err) => {
            readout.innerHTML = `<span style="color:var(--accent-danger);">❌ GPS Error: ${err.message}</span>`;
        }, { enableHighAccuracy: true });
    });

    document.getElementById("addForm").addEventListener("submit", (e) => {
        const name = document.getElementById("nameInput").value.trim();
        const designation = document.getElementById("designationInput").value.trim();
        if (!name || !designation) return;

        if (!mySelfId) mySelfId = "OP-" + Math.random().toString(36).slice(2, 8).toUpperCase();
        
        let pLat = null, pLon = null, pHeight = 0;

        if (isManual) {
            pHeight = parseFloat(document.getElementById("manualHeight").value) || 0;
        } else if (pendingLocation) {
            pLat = pendingLocation.lat;
            pLon = pendingLocation.lon;
            pHeight = pendingLocation.height;
        }

        const person = {
            id: mySelfId,
            name: name,
            designation: designation,
            height: pHeight,
            lat: pLat,
            lon: pLon,
            method: isManual ? "manual" : "auto"
        };

        const existingIndex = group.findIndex(p => p.id === mySelfId);
        if (existingIndex > -1) group[existingIndex] = person;
        else group.push(person);

        socket.emit('updateGroupData', group);
        
        if (!isManual) startTracking(mySelfId);
        renderUI();
    });

    // 3. LIVE GPS TRACKING 
    window.toggleTrack = function(id) {
        if (liveTrackingId === id) stopTracking();
        else startTracking(id);
    };

    window.removeNode = function(id) {
        if (liveTrackingId === id) stopTracking();
        socket.emit('removePerson', id);
    };

    function startTracking(personId) {
        if (!navigator.geolocation) return showAlert("Geolocation is not supported by your browser.");
        stopTracking();
        liveTrackingId = personId;
        renderUI(); 

        gpsWatchId = navigator.geolocation.watchPosition((pos) => {
            const person = group.find(p => p.id === liveTrackingId);
            if (person) {
                person.lat = pos.coords.latitude;
                person.lon = pos.coords.longitude;
                if (pos.coords.altitude !== null) person.height = pos.coords.altitude;
                
                // Update weather silently on movement
                fetchWeatherAndAQI(person.lat, person.lon);

                checkKinematicDrop(person);
                socket.emit('updateGroupData', group);
                renderUI();
            }
        }, (err) => { showAlert(`GPS Error: ${err.message}`); }, { enableHighAccuracy: true, maximumAge: 0 });
    }

    function stopTracking() {
        if (gpsWatchId) navigator.geolocation.clearWatch(gpsWatchId);
        liveTrackingId = null;
        gpsWatchId = null;
        renderUI();
    }

    function checkKinematicDrop(person) {
        const now = Date.now();
        const limit = parseFloat(document.getElementById("dropInput").value) || 1.5;
        const windowSec = parseInt(document.getElementById("windowInput").value) || 4;
        
        kinematicHistory.push({ time: now, h: person.height });
        kinematicHistory = kinematicHistory.filter(e => now - e.time <= windowSec * 1000);
        
        if (kinematicHistory.length >= 2) {
            const peak = Math.max(...kinematicHistory.map(e => e.h));
            if (peak - person.height >= limit) {
                socket.emit('triggerFallAlert', { name: person.name, drop: (peak - person.height).toFixed(2), id: person.id });
                kinematicHistory = []; 
            }
        }
    }

    // 4. MASTER RENDER ENGINE
    function renderUI() {
        statActive.textContent = `${group.length} Tracked`;
        
        if (group.length === 0) {
            document.getElementById("emptyHint").style.display = "flex";
            rosterList.innerHTML = ""; graphSvg.innerHTML = "";
        } else {
            document.getElementById("emptyHint").style.display = "none";
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
            if (currentRole === "admin" || isMe) {
                actionBtns += `<button class="mini-btn remove-btn" onclick="removeNode('${p.id}')">✕ Eject</button>`;
                actionBtns += `<button class="mini-btn track-btn ${isLive ? 'active' : ''}" onclick="toggleTrack('${p.id}')">${isLive ? "⏹ Halt GPS" : "📍 Track GPS"}</button>`;
            }

            return `
                <li class="roster-item ${isLive ? 'is-live' : ''}">
                    <div class="roster-info">
                        <strong>${currentRole === 'admin' && p.id === group[0].id ? '👑 ' : ''}${p.name}</strong>
                        <span class="roster-sub">${p.designation} <br> Raw Z: ${p.height.toFixed(2)}m</span>
                    </div>
                    <div class="roster-status ${statusClass}">${(relHeight >= 0 ? "+" : "")}${relHeight.toFixed(2)}m</div>
                    <div class="roster-actions">${actionBtns}</div>
                </li>
            `;
        }).join('');
    }

    function renderGraph() {
        const W = graphSvg.clientWidth || 1000; // Expanded for Hero panel
        const H = graphSvg.clientHeight || 600; // Expanded for Hero panel
        const padding = 60; const limit = parseFloat(document.getElementById("limitInput").value) || 2;
        const rels = group.map(p => p.height - globalBaseline);
        const maxAbs = Math.max(limit * 1.5, ...rels.map(Math.abs), 1);
        const scaleY = (H / 2 - padding) / maxAbs; const midY = H / 2;

        let svgHtml = `<line class="baseline" x1="10" y1="${midY}" x2="${W - 10}" y2="${midY}"></line>
                       <text class="axis-label" x="${W - 50}" y="${midY - 10}" fill="#38bdf8">DATUM 0m</text>`;

        group.forEach((p, i) => {
            const rel = p.height - globalBaseline;
            const x = padding + ((W - padding * 2) * (i + 0.5)) / group.length;
            const y = midY - (rel * scaleY);
            const status = rel > limit ? "above" : rel < -limit ? "below" : "within";

            svgHtml += `
                <g class="figure figure-${status}" style="transform: translate(${x}px, ${y}px)">
                    ${p.id === liveTrackingId ? '<circle class="live-halo" r="30" cy="-10"></circle>' : ''}
                    <text class="figure-readout" x="0" y="-55" text-anchor="middle" font-size="16" font-weight="bold">${(rel >= 0 ? "+" : "")}${rel.toFixed(2)}m</text>
                    
                    <circle class="figure-head" cx="0" cy="-30" r="10"></circle>
                    <line class="figure-body" x1="0" y1="-20" x2="0" y2="10"></line>
                    <line class="figure-arm" x1="0" y1="-15" x2="-15" y2="-5"></line>
                    <line class="figure-arm" x1="0" y1="-15" x2="15" y2="-5"></line>
                    <line class="figure-leg" x1="0" y1="10" x2="-12" y2="30"></line>
                    <line class="figure-leg" x1="0" y1="10" x2="12" y2="30"></line>
                    
                    <text class="figure-label" x="0" y="55" text-anchor="middle" font-size="14" font-weight="bold" fill="#fff">${p.name}</text>
                    <text class="figure-label-sub" x="0" y="70" text-anchor="middle" font-size="11" fill="#94a3b8">${p.designation}</text>
                </g>
            `;
        });
        graphSvg.innerHTML = svgHtml;
    }

    function renderMap() {
        if (!map && typeof L !== "undefined") {
            map = L.map('map').setView([20.5937, 78.9629], 5);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
        }
        if (!map) return;

        const currentIds = group.map(p => p.id);
        for (let id in markers) {
            if (!currentIds.includes(id)) { map.removeLayer(markers[id]); delete markers[id]; }
        }

        group.forEach(p => {
            if (p.lat && p.lon) {
                if (markers[p.id]) markers[p.id].setLatLng([p.lat, p.lon]);
                else {
                    const iconHtml = `<svg width="30" height="30" viewBox="0 0 24 24" fill="${p.id === liveTrackingId ? '#f59e0b' : '#38bdf8'}"><circle cx="12" cy="12" r="10" stroke="#fff" stroke-width="2"/></svg>`;
                    const divIcon = L.divIcon({ className: 'tactical-marker', html: iconHtml, iconSize: [30,30] });
                    markers[p.id] = L.marker([p.lat, p.lon], { icon: divIcon }).addTo(map).bindPopup(`<b>${p.name}</b><br>${p.designation}`);
                }
            }
        });
    }

    function showAlert(msg) {
        alertBanner.textContent = msg; alertBanner.classList.add("show"); alertBanner.hidden = false;
        setTimeout(() => alertBanner.classList.remove("show"), 4000);
    }

    function logEvent(msg) {
        logs.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if(logs.length > 20) logs.pop();
        document.getElementById("logList").innerHTML = logs.map(l => `<li class="log-item">${l}</li>`).join("");
    }

    function triggerBeep() { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); }

    if (typeof L !== "undefined") setTimeout(renderMap, 500);

})();
