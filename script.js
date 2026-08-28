/* ============================================================
   ALTIGUARD: ENTERPRISE COMMAND ENGINE
   Features: Dual-Mode, 5-Min Tracing, AI, SOS, Battery, Geofence
   ============================================================ */

(function () {
  "use strict";

  const STORAGE = { settings: "altiguard_settings_v1", mode: "altiguard_mode" };
  function saveJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch(e){} }
  function loadJSON(key, fallback) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch(e) { return fallback; } }

  let settings = loadJSON(STORAGE.settings, { limit: 2, dropThreshold: 1.5, dropWindow: 4, ntfyTopic: "", floorHeight: 3.5 });
  
  let isFancyMode = loadJSON(STORAGE.mode, true); 

  const socket = io(); 
  let currentRoom = "TEAM123", userRole = "worker", mySelfPersonId = null; 

  let group = [], alerts = [], serverLogs = [], dangerZones = [];
  let globalReference = 0, isAlerting = false, alertClearTimeout = null, isSocketConnected = false;
  
  let userTraces = {}, tracedWorkerId = null; 
  
  let currentBattery = "100";
  if (navigator.getBattery) {
    navigator.getBattery().then(b => {
      currentBattery = Math.round(b.level * 100);
      b.addEventListener('levelchange', () => {
        currentBattery = Math.round(b.level * 100);
        if(currentBattery <= 15) socket.emit('logIncident', `⚠️ LOW BATTERY: A device is at ${currentBattery}%.`);
      });
    });
  }

  let map = null, markers = {}, traceLayer = null, zoneLayers = [];
  let weatherControl = null, lastWeatherFetch = 0, lastWeatherCoords = null;
  let tileLayer = null; 

  async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 8000 } = options; const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try { const res = await fetch(resource, { ...options, signal: controller.signal }); clearTimeout(id); return res; } 
    catch (err) { clearTimeout(id); throw err; }
  }

  function applyVisualMode() {
    if (isFancyMode) {
      document.body.classList.add('fancy-mode');
      document.body.classList.remove('simple-mode');
      if (map && tileLayer && !map.hasLayer(tileLayer)) map.addLayer(tileLayer); 
    } else {
      document.body.classList.add('simple-mode');
      document.body.classList.remove('fancy-mode');
      if (map && tileLayer && map.hasLayer(tileLayer)) map.removeLayer(tileLayer); 
    }
    const toggleBtn = document.getElementById("modeToggleBtn");
    if(toggleBtn) toggleBtn.innerHTML = isFancyMode ? "⚡ Switch to Data Saver" : "🌌 Switch to Fancy Mode";
  }

  socket.on('connect', () => { isSocketConnected = true; renderSummary(); });
  socket.on('disconnect', () => { isSocketConnected = false; renderSummary(); });
  socket.on('connect_error', () => { isSocketConnected = false; renderSummary(); });
  
  socket.on('roleAssigned', ({ role, roomCode }) => {
    userRole = role; currentRoom = roomCode;
    const codeInput = document.getElementById("groupCodeInput"); if (codeInput) codeInput.value = roomCode;
    showAlertBanner(`Joined Group ${roomCode} as ${role.toUpperCase()}`);
    renderRoleUI(); render();
  });

  socket.on('groupError', (msg) => showAlertBanner(`⚠️ ${msg}`));
  socket.on('syncReference', (ref) => { globalReference = ref; const refIn = document.getElementById("referenceInput"); if (refIn) refIn.value = ref; render(); });
  socket.on('syncLogs', (logs) => { serverLogs = logs; });
  
  socket.on('syncZones', (zones) => {
    dangerZones = zones;
    if (map && typeof L !== "undefined" && isFancyMode) {
      zoneLayers.forEach(layer => map.removeLayer(layer)); zoneLayers = [];
      dangerZones.forEach(z => {
        const circle = L.circle([z.lat, z.lon], { color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.4, radius: z.radius }).addTo(map);
        circle.bindPopup("<b>⚠️ DANGER ZONE</b>"); zoneLayers.push(circle);
      });
    }
  });

  socket.on('syncGroup', (serverGroup) => {
    if (mySelfPersonId) {
      const me = serverGroup.find(p => p.id === mySelfPersonId);
      if (me && me.role !== userRole && userRole !== 'creator') {
        userRole = me.role; showAlertBanner(`Access updated to ${userRole.toUpperCase()}`); renderRoleUI();
      }
    }
    group = serverGroup;
    
    const now = Date.now();
    group.forEach(p => {
      if (p.lat && p.lon) {
        if (!userTraces[p.id]) userTraces[p.id] = [];
        const last = userTraces[p.id][userTraces[p.id].length - 1];
        if (!last || last.lat !== p.lat || last.lon !== p.lon) {
          userTraces[p.id].push({ lat: p.lat, lon: p.lon, time: now });
        }
        userTraces[p.id] = userTraces[p.id].filter(t => now - t.time <= 300000); 
      }
    });
    render();
  });

  socket.on('receiveSOS', (payload) => {
    vibrate(); beep(); isAlerting = true;
    showAlertBanner(`🚨 SOS TRIGGERED BY ${escapeHtml(payload.name).toUpperCase()}!`);
    const sosBanner = document.getElementById('sosAlertBanner');
    if (sosBanner) {
      sosBanner.style.display = 'flex';
      sosBanner.innerHTML = `<h1>🚨 EMERGENCY: ${escapeHtml(payload.name)} 🚨</h1><p>Elevation: ${payload.height.toFixed(2)}m</p>`;
      setTimeout(() => sosBanner.style.display = 'none', 10000);
    }
    if (map && payload.lat && payload.lon && isFancyMode) map.setView([payload.lat, payload.lon], 18);
  });

  socket.on('receiveEmergencyBroadcast', (payload) => {
    vibrate(); beep();
    const coordsMsg = (payload.lat && payload.lon) ? `<br><a href="https://www.google.com/maps?q=${payload.lat},${payload.lon}" target="_blank" style="color:var(--amber);">📍 Open GPS</a>` : "";
    showAlertBanner(`🚨 BROADCAST: ${escapeHtml(payload.name)} at ${payload.height.toFixed(2)}m! ${coordsMsg}`);
    if (map && payload.lat && payload.lon && isFancyMode) map.setView([payload.lat, payload.lon], 16);
  });

  socket.on('receiveAlert', (entry) => {
    alerts.unshift(entry); if (alerts.length > 50) alerts.length = 50;
    renderLog(); showAlertBanner(`⚠️ Sudden drop — ${entry.name} dropped ${entry.drop} m`);
    vibrate(); beep(); if (entry.personId) flashFigure(entry.personId); triggerSiteAlarm();
  });

  function syncToServer() { if (isSocketConnected) socket.emit('updateGroup', group); }

  function ensureGroupControls() {
    if (document.getElementById("groupControlWrapper")) return;
    const joinBtn = document.getElementById("joinRoomBtn"); if (!joinBtn) return;
    const wrapper = document.createElement("div"); wrapper.id = "groupControlWrapper"; wrapper.className = "group-control-row";
    wrapper.innerHTML = `<button type="button" id="createGroupBtn" class="primary-btn" style="background:var(--teal); color:#000;">+ Create Group</button><button type="button" id="joinGroupActionBtn" class="primary-btn" style="background:transparent; border:1px solid var(--teal); color:var(--teal);">Join Group</button>`;
    joinBtn.parentNode.insertBefore(wrapper, joinBtn); joinBtn.style.display = "none"; 
    document.getElementById("createGroupBtn").addEventListener("click", () => socket.emit('createGroup', document.getElementById("groupCodeInput")?.value.trim()));
    document.getElementById("joinGroupActionBtn").addEventListener("click", () => {
      const code = document.getElementById("groupCodeInput")?.value.trim();
      if (!code) return showAlertBanner("Please enter a Group Code.");
      socket.emit('joinGroup', code);
    });
  }

  function ensureNewUIElements() {
    ensureGroupControls();
    
    if (!document.getElementById("modeToggleBtn")) {
      const modeBtn = document.createElement("button"); modeBtn.id = "modeToggleBtn";
      Object.assign(modeBtn.style, { position:"absolute", top:"20px", right:"20px", background:"rgba(0,0,0,0.5)", color:"#fff", border:"1px solid var(--teal)", padding:"8px 12px", borderRadius:"6px", cursor:"pointer", fontSize:"10px", fontFamily:"var(--font-mono)", zIndex:"1000" });
      modeBtn.onclick = () => { isFancyMode = !isFancyMode; saveJSON(STORAGE.mode, isFancyMode); applyVisualMode(); render(); };
      document.body.appendChild(modeBtn);
    }

    if (!document.getElementById("summaryBar")) {
      const main = document.querySelector("main") || document.body;
      const bar = document.createElement("div"); bar.id = "summaryBar"; bar.className = "summary-bar";
      bar.innerHTML = `<div class="stat-box"><span class="stat-label">Role</span><strong id="statRole" style="color:var(--teal);">CONNECTING...</strong></div><div class="stat-box"><span class="stat-label">Active</span><strong id="statActive">0 Tracked</strong></div><div class="stat-box"><span class="stat-label">Status</span><strong id="statStatus" class="status-secure">🟢 ONLINE</strong></div>`;
      if(main) main.insertBefore(bar, main.firstChild);
    }

    if (!document.getElementById("adminControls")) {
      const main = document.querySelector("main") || document.body;
      const ctrl = document.createElement("div"); ctrl.id = "adminControls"; ctrl.className = "admin-controls-row"; ctrl.style.display = "none";
      ctrl.innerHTML = `<button id="emergencyBroadcastBtn" class="emergency-broadcast-btn">🚨 Broadcast Location</button><button id="exportCsvBtn" class="export-btn">📊 Export Shift Log</button>`;
      if(main) main.insertBefore(ctrl, main.children[1] || null);
      document.getElementById("emergencyBroadcastBtn").addEventListener("click", triggerEmergencyBroadcast);
      document.getElementById("exportCsvBtn").addEventListener("click", exportShiftReport);
    }

    if (!document.getElementById("sosTriggerBtn")) {
      const sos = document.createElement("button"); sos.id = "sosTriggerBtn"; sos.innerHTML = "🚨 SOS PANIC";
      Object.assign(sos.style, { position: "fixed", bottom: "30px", left: "50%", transform: "translateX(-50%)", zIndex: "9999", background: "linear-gradient(135deg, #ef4444, #f43f5e)", color: "#fff", border: "none", padding: "15px 30px", borderRadius: "40px", fontFamily: "var(--font-display)", fontWeight: "bold", fontSize: "16px", cursor: "pointer", boxShadow: "0 0 25px rgba(239, 68, 68, 0.6)" });
      sos.onclick = triggerSOS; document.body.appendChild(sos);
    }

    if (!document.getElementById("sosAlertBanner")) {
      const sosBanner = document.createElement("div"); sosBanner.id = "sosAlertBanner";
      Object.assign(sosBanner.style, { position: "fixed", top: "0", left: "0", width: "100%", height: "100%", zIndex: "10000", background: "rgba(239, 68, 68, 0.95)", color: "#fff", display: "none", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", textShadow: "0 2px 10px rgba(0,0,0,0.5)" });
      document.body.appendChild(sosBanner);
    }

    if (!document.getElementById("aiAdvisorBtn")) {
      const btn = document.createElement("button"); btn.id = "aiAdvisorBtn"; btn.innerHTML = "✨ AI Advisor";
      Object.assign(btn.style, { position: "fixed", bottom: "30px", left: "30px", zIndex: "9999", background: "linear-gradient(135deg, #2fd4c4, #10b981)", color: "#0a0f1c", border: "none", padding: "12px 20px", borderRadius: "30px", fontFamily: "var(--font-display)", fontWeight: "bold", fontSize: "14px", cursor: "pointer", boxShadow: "0 0 20px rgba(47, 212, 196, 0.4)" });
      
      const modal = document.createElement("div"); modal.id = "aiModal";
      Object.assign(modal.style, { position: "fixed", bottom: "80px", left: "30px", zIndex: "9998", background: "rgba(10, 15, 28, 0.95)", backdropFilter: "blur(10px)", border: "1px solid var(--teal)", borderRadius: "var(--radius)", padding: "20px", width: "320px", color: "var(--teal)", fontFamily: "var(--font-mono)", fontSize: "12px", lineHeight: "1.6", boxShadow: "0 10px 30px rgba(0,0,0,0.5)", display: "none", transform: "translateY(10px)", opacity: "0", transition: "all 0.3s ease" });
      
      document.body.appendChild(btn); document.body.appendChild(modal);

      btn.onclick = () => {
        if (group.length === 0) { modal.innerHTML = "⚠️ No active personnel to analyze."; modal.style.display="block"; modal.style.opacity="1"; setTimeout(()=>modal.style.display="none", 5000); return; }
        btn.innerHTML = "⏳ AI Thinking...";
        const h = Math.max(...group.map(p => p.height - getGroupReference())).toFixed(1);
        socket.emit('requestAiInsight', { workerCount: group.length, highestElevation: h, temperature: document.getElementById("wTemp")?.textContent || "N/A", windSpeed: document.getElementById("wWind")?.textContent || "N/A", zonesCount: dangerZones.length });
      };

      socket.on('aiInsightResponse', (res) => {
        btn.innerHTML = "✨ AI Advisor";
        modal.innerHTML = res.error ? `❌ <b>Error:</b><br>${res.error}` : `🤖 <b>Altiguard AI Analysis:</b><br><br>${res.result}`;
        modal.style.display = "block"; setTimeout(() => { modal.style.transform = "translateY(0)"; modal.style.opacity = "1"; }, 10);
        setTimeout(() => { modal.style.transform = "translateY(10px)"; modal.style.opacity = "0"; setTimeout(() => modal.style.display="none", 300); }, 10000);
      });
    }

    if (!document.getElementById("devCredit")) {
      const credit = document.createElement("div"); credit.className = "dev-credit";
      credit.innerHTML = "ALTIGUARD // ENGINEERED BY VAIBHAV RAJU KONDANE";
      document.body.appendChild(credit);
    }
  }

  function renderRoleUI() {
    const roleBadge = document.getElementById("statRole"); if (roleBadge) roleBadge.textContent = userRole.toUpperCase();
    const ctrl = document.getElementById("adminControls");
    if (ctrl) ctrl.style.display = (userRole === "creator" || userRole === "sub-admin") ? "flex" : "none";
    
    const mapContainer = document.getElementById("map");
    if (mapContainer && (userRole === "creator" || userRole === "sub-admin") && !document.getElementById("mapDrawHint")) {
      const hint = document.createElement("div"); hint.id="mapDrawHint";
      hint.innerHTML = "🗺️ <i>Right-Click Map to add Danger Zone.</i>";
      hint.style.cssText = "position:absolute; bottom:10px; left:10px; z-index:999; background:rgba(15,23,42,0.8); color:var(--amber); padding:5px 10px; font-size:10px; border-radius:4px;";
      const clearBtn = document.createElement("button"); clearBtn.innerHTML="Clear"; clearBtn.style.cssText="margin-left:10px; background:var(--red); color:#fff; border:none; padding:2px 6px; cursor:pointer; border-radius:4px;";
      clearBtn.onclick = () => socket.emit('clearZones');
      hint.appendChild(clearBtn); mapContainer.appendChild(hint);
    }
  }

  function exportShiftReport() {
    if (userRole !== "creator" && userRole !== "sub-admin") return;
    let csv = "ALTIGUARD END OF SHIFT REPORT\nDate,Time,Event Type,Details,Metric\n";
    const dateStr = new Date().toLocaleDateString();
    group.forEach(p => csv += `${dateStr},--,ROSTER,Worker: ${p.name},Max H: ${p.height.toFixed(2)}m (Bat: ${p.battery}%)\n`);
    serverLogs.forEach(l => { const d = new Date(l.time); csv += `${d.toLocaleDateString()},${d.toLocaleTimeString()},INCIDENT,${l.msg},--\n`; });
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `Altiguard_Shift_Report_${Date.now()}.csv`; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function triggerSOS() {
    if(!mySelfPersonId) return showAlertBanner("Join the group first to use SOS.");
    const me = group.find(p => p.id === mySelfPersonId);
    if(me) {
      socket.emit('triggerSOS', { name: me.name, lat: me.lat, lon: me.lon, height: me.height });
      const activeTopic = document.getElementById("ntfyTopicInput")?.value.trim() || settings.ntfyTopic;
      if (activeTopic) fetchWithTimeout(`https://ntfy.sh/${activeTopic.replace(/[^a-zA-Z0-9-_]/g, "")}`, { method: 'POST', body: `🚨 SOS BY ${me.name} 🚨`, headers: { 'Title': 'Altiguard SOS', 'Priority': 'urgent', 'Tags': 'sos,rotating_light' } }).catch(()=>{});
    }
  }

  function triggerEmergencyBroadcast() {
    if (group.length === 0) return showAlertBanner("No workers in group.");
    const livePerson = group.find(p => p.id === livePersonId) || group.find(p => p.id === mySelfPersonId) || group[0];
    socket.emit('broadcastEmergencyLocation', { role: userRole, name: livePerson.name, height: livePerson.height, lat: livePerson.lat, lon: livePerson.lon });
    showAlertBanner(`🚨 Location of ${livePerson.name} broadcasted!`);
  }

  function triggerSiteAlarm() { isAlerting = true; clearTimeout(alertClearTimeout); renderSummary(); alertClearTimeout = setTimeout(() => { isAlerting = false; renderSummary(); }, 15000); }
   
  let manualMode = false, pendingCapture = null, livePersonId = null, watchId = null, liveHistory = [], baroSensor = null, baroBaseline = null, audioCtx = null, bannerTimeout = null;

  function uid() { return "p_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36); }
  function escapeHtml(str) { return String(str).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }
  function fmtSigned(n, digits) { return (n >= 0 ? "+" : "") + n.toFixed(digits); }
  function getGroupReference() { return globalReference; }
  function statusFor(rel) { return rel > settings.limit ? "above" : rel < -settings.limit ? "below" : "within"; }
  function statusLabel(status) { return status === "within" ? "within limit" : status === "above" ? "above limit" : "below limit"; }
  function methodLabelFor(method) { switch (method) { case "barometer": return "Barometer"; case "gps": return "GPS"; case "manual": return "Manual"; default: return method || "GPS"; } }
  function niceStep(maxVal) { const rough = maxVal / 4; const mag = Math.pow(10, Math.floor(Math.log10(rough || 1))); const norm = rough / mag; return norm < 1.5 ? 1 * mag : norm < 3 ? 2 * mag : norm < 7 ? 5 * mag : 10 * mag; }
  
  function unlockAudio() { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === "suspended") audioCtx.resume(); } catch (e) {} }
  function beep() { if (!audioCtx) return; try { const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain(); osc.type = "square"; osc.frequency.value = 880; gain.gain.setValueAtTime(0.2, audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.3); osc.connect(gain).connect(audioCtx.destination); osc.start(); osc.stop(audioCtx.currentTime + 0.3); } catch (e) {} }
  function vibrate() { if (navigator.vibrate) try { navigator.vibrate([200, 100, 200, 100, 400]); } catch (e) {} }
  function pressureToRelativeAltitude(currentHPa, baseHPa) { return 44330 * (1 - Math.pow(currentHPa / baseHPa, 1 / 5.255)); }

  async function initBarometer() { if (!("Barometer" in window)) return; try { baroSensor = new Barometer({ frequency: 1 }); baroSensor.addEventListener("reading", () => { if (baroBaseline === null) baroBaseline = baroSensor.pressure; }); baroSensor.start(); } catch (e) {} }
  function currentBaroDelta() { if (baroSensor && baroBaseline !== null && typeof baroSensor.pressure === "number") { return pressureToRelativeAltitude(baroSensor.pressure, baroBaseline); } return null; }

  function capture() {
    const readout = document.getElementById("captureReadout");
    if (!navigator.geolocation) return; unlockAudio(); if (readout) readout.innerHTML = '<span>Acquiring...</span>';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, altitude, accuracy } = pos.coords;
        pendingCapture = { lat: latitude, lon: longitude, height: altitude ?? 0, accuracy, method: altitude ? "gps" : "gps-no-altitude" };
        if (readout) readout.innerHTML = `✓ ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`; updateAddButtonState();
      },
      (err) => { if (readout) readout.innerHTML = `Error: ${err.message}`; },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  function hasValidPending() { if (manualMode) { const el = document.getElementById("manualHeight"); return !isNaN(parseFloat(el?.value)); } return !!(pendingCapture && pendingCapture.height !== null); }
  function updateAddButtonState() { const addBtn = document.getElementById("addBtn"); if (addBtn) addBtn.disabled = !hasValidPending(); }
  function resetForm() { ["nameInput", "workerPhoneInput", "manualHeight", "manualLat", "manualLon"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; }); pendingCapture = null; manualMode = false; updateAddButtonState(); }

  function startTracking() {
    if (!navigator.geolocation) return; stopTracking(); unlockAudio(); livePersonId = mySelfPersonId; lastValidHeight = null;
    watchId = navigator.geolocation.watchPosition(onLiveUpdate, (err) => showAlertBanner(err.message), { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    render();
  }
  function stopTracking() { if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; } livePersonId = null; render(); }

  function checkGeofences(person) {
    if (!person.lat || !person.lon || !map || typeof L === "undefined") return;
    dangerZones.forEach(z => {
      const dist = map.distance([person.lat, person.lon], [z.lat, z.lon]);
      if (dist < z.radius && !person.inZone) {
        person.inZone = true;
        socket.emit('logIncident', `⚠️ BREACH: ${person.name} entered Danger Zone.`);
        showAlertBanner(`⚠️ ZONE BREACH: ${person.name} entered Danger Zone!`); beep(); vibrate();
      } else if (dist >= z.radius) person.inZone = false;
    });
  }

  function onLiveUpdate(pos) {
    const person = group.find(p => p.id === livePersonId); if (!person) { stopTracking(); return; }
    const { latitude, longitude, altitude, accuracy } = pos.coords;
    let height = altitude ?? person.height ?? 0;
    const baroDelta = currentBaroDelta();
    if (baroDelta !== null) { if (person._baroRef === undefined) person._baroRef = height - baroDelta; height = person._baroRef + baroDelta; }
    
    person.lat = latitude; person.lon = longitude; person.height = height; person.accuracy = accuracy; 
    person.battery = currentBattery; person.updatedAt = new Date().toISOString();
    
    checkDrop(person); checkGeofences(person); syncToServer(); render();
  }

  function checkDrop(person) {
    const now = Date.now(); liveHistory.push({ t: now, h: person.height });
    const windowMs = settings.dropWindow * 1000; liveHistory = liveHistory.filter(r => now - r.t <= windowMs + 2000);
    const inWindow = liveHistory.filter(r => now - r.t <= windowMs); if (inWindow.length < 2) return;
    const peak = Math.max(...inWindow.map(r => r.h)); const drop = peak - person.height;
    if (drop >= settings.dropThreshold) { triggerAlert(person, drop, false); liveHistory = [{ t: now, h: person.height }]; }
  }

  function triggerAlert(person, dropAmount, isTest) {
    const topicInput = document.getElementById("ntfyTopicInput");
    const activeTopic = topicInput ? topicInput.value.trim() : (settings.ntfyTopic || "");
    const entry = { id: uid(), name: person ? person.name : "Worker", drop: Number(dropAmount.toFixed(2)), lat: person ? person.lat : null, lon: person ? person.lon : null, time: new Date().toISOString(), test: !!isTest, ntfyTopic: activeTopic };
    alerts.unshift(entry); if (alerts.length > 50) alerts.length = 50;
    
    socket.emit('logIncident', `⚠️ FALL DETECTED: ${entry.name} dropped ${entry.drop}m.`);
    socket.emit('triggerAlert', entry); renderLog(); triggerSiteAlarm(); showAlertBanner(`⚠️ Sudden drop — ${entry.name} dropped ${entry.drop} m`); vibrate(); beep();
    if (activeTopic) {
      const cleanTopic = activeTopic.replace(/[^a-zA-Z0-9-_]/g, "");
      fetchWithTimeout(`https://ntfy.sh/${cleanTopic}`, { method: 'POST', body: `Drop Alert: ${entry.name} dropped ${entry.drop}m!`, headers: { 'Title': 'Altiguard Alert', 'Priority': 'urgent' }, timeout: 5000 }).catch(() => {});
    }
  }

  function showAlertBanner(msg) { const banner = document.getElementById("alertBanner"); if (!banner) return; banner.innerHTML = msg; banner.classList.add("show"); clearTimeout(bannerTimeout); bannerTimeout = setTimeout(() => banner.classList.remove("show"), 6000); }
  function flashFigure(id) { const el = document.querySelector(`.figure[data-person-id="${id}"]`); if (!el) return; el.classList.add("figure-flash"); setTimeout(() => el.classList.remove("figure-flash"), 4000); }

  function render() { renderSummary(); renderRoster(); renderGraph(); renderLog(); renderMap(); checkWeather(); }

  function renderSummary() {
    const elActive = document.getElementById("statActive"), elStatus = document.getElementById("statStatus");
    if (!elActive || !elStatus) return; elActive.textContent = `${group.length} Personnel`;
    if (isAlerting) { elStatus.className = "status-danger"; elStatus.innerHTML = "🔴 FALL DETECTED"; } 
    else { elStatus.className = "status-secure"; elStatus.innerHTML = isSocketConnected ? "🟢 SECURE" : "🔴 OFFLINE"; }
  }

  function renderRoster() {
    const list = document.getElementById("rosterList"), emptyHint = document.getElementById("emptyHint");
    if (!list || !emptyHint) return; if (group.length === 0) { list.innerHTML = ""; emptyHint.hidden = false; return; }
    emptyHint.hidden = true; const mean = getGroupReference();

    list.innerHTML = group.map((p) => {
      const rel = p.height - mean, status = statusFor(rel), isSelf = p.id === mySelfPersonId;
      const roleIcon = p.role === 'creator' ? '👑' : p.role === 'sub-admin' ? '⭐' : '👷';
      const batStr = p.battery ? `<span style="color:${p.battery<20?'var(--red)':'var(--teal)'};font-size:10px; margin-left:8px;">🔋${p.battery}%</span>` : "";
      
      const canRemove = (userRole === "creator") || (userRole === "sub-admin" && p.role !== "creator") || isSelf;
      const canPromote = (userRole === "creator") && !isSelf;

      let actions = "";
      if (isSelf) {
        const isTrackingSelf = livePersonId === p.id;
        actions += `<button class="mini-btn track-btn ${isTrackingSelf ? "active" : ""}" data-id="${p.id}">${isTrackingSelf ? "⏹ Stop GPS" : "📍 Start My GPS"}</button>`;
      }
      if (userRole === "creator" || userRole === "sub-admin") {
        const isTraced = tracedWorkerId === p.id;
        actions += `<button class="mini-btn trace-btn ${isTraced ? "active" : ""}" data-id="${p.id}">🗺️ ${isTraced ? "Hide Trace" : "Trace 5m"}</button>`;
      }
      if (canPromote) {
        if (p.role === 'worker') actions += `<button class="mini-btn promote-btn" data-id="${p.id}">⭐ Admin</button>`;
        else if (p.role === 'sub-admin') actions += `<button class="mini-btn demote-btn" data-id="${p.id}">⬇️ Demote</button>`;
      }
      if (canRemove) actions += `<button class="mini-btn remove-btn" data-id="${p.id}">${isSelf && userRole !== 'creator' ? '✕ Leave' : '✕ Rm'}</button>`;

      return `
      <li class="roster-item ${p.inZone ? "zone-breach" : ""}">
        <div class="roster-info">
          <strong>${roleIcon} ${escapeHtml(p.name)} ${isSelf ? '<small>(You)</small>' : ''} ${batStr}</strong>
          <span class="roster-sub">${p.height.toFixed(2)}m · ${methodLabelFor(p.method)}</span>
        </div>
        <div class="roster-status status-${status}">${fmtSigned(rel, 2)} m<small>${statusLabel(status)}</small></div>
        <div class="roster-actions">${actions}</div>
      </li>`;
    }).join("");
  }

  function figureSVG(x, y, status, isLive, name, rel, id) { const cls = `figure figure-${status}${isLive ? " figure-live" : ""}`; return `<g class="${cls}" data-person-id="${id}" style="--fx: ${x.toFixed(1)}px; --fy: ${y.toFixed(1)}px;">${isLive ? '<circle class="live-halo" r="14"></circle>' : ""}<text class="figure-readout" x="0" y="-28" text-anchor="middle">${fmtSigned(rel, 2)}m</text><circle class="figure-head" cx="0" cy="-14" r="6"></circle><line class="figure-body" x1="0" y1="-8" x2="0" y2="10"></line><text class="figure-label" x="0" y="39" text-anchor="middle">${escapeHtml(name)}</text></g>`; }

  function renderGraph() {
    const svg = document.getElementById("graphSvg"); if (!svg || group.length === 0) return;
    const W = 640, H = 380, marginL = 58, marginR = 20, marginT = 20, marginB = 46, plotW = W - marginL - marginR, plotH = H - marginT - marginB, midY = marginT + plotH / 2, mean = getGroupReference(), rels = group.map(p => p.height - mean), maxAbs = Math.max(settings.limit * 1.2, ...rels.map(r => Math.abs(r)), 1), scale = (plotH / 2) / maxAbs, parts = [];
    group.forEach((p, i) => { const rel = p.height - mean, x = marginL + (plotW * (i + 0.5)) / group.length, y = midY - rel * scale; parts.push(figureSVG(x, y, statusFor(rel), p.id === livePersonId, p.name, rel, p.id)); });
    svg.innerHTML = parts.join("");
  }

  function renderLog() { const list = document.getElementById("logList"); if (!list) return; list.innerHTML = alerts.slice(0, 15).map(a => `<li class="log-item"><span class="log-time">${new Date(a.time).toLocaleTimeString()}</span><span class="log-text">${escapeHtml(a.name)} dropped <strong>${a.drop} m</strong></span></li>`).join(""); }
  
  function initMap() { 
    const mapEl = document.getElementById("map"); if (!mapEl || typeof L === "undefined") return; 
    try { 
      map = L.map('map').setView([20.5937, 78.9629], 5); 
      
      tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 });
      if (isFancyMode) tileLayer.addTo(map);

      hospitalLayer = L.layerGroup().addTo(map); traceLayer = L.layerGroup().addTo(map);

      map.on('contextmenu', (e) => {
        if (userRole === "creator" || userRole === "sub-admin") {
          socket.emit('addZone', { lat: e.latlng.lat, lon: e.latlng.lng, radius: 50 });
          showAlertBanner("🗺️ Danger Zone Added (50m Radius)");
        }
      });
    } catch(e) {} 
  }
  
  function renderMap() { 
    if (!map || typeof L === "undefined") return; 
    
    if (!isFancyMode) { document.getElementById("map").style.display = "none"; return; }
    else { document.getElementById("map").style.display = "block"; }

    const currentIds = group.map(p => p.id); 
    for (let id in markers) { if (!currentIds.includes(id)) { map.removeLayer(markers[id]); delete markers[id]; } } 
    
    group.forEach(p => { 
      if (p.lat && p.lon) { 
        if (markers[p.id]) markers[p.id].setLatLng([p.lat, p.lon]); 
        else markers[p.id] = L.marker([p.lat, p.lon]).addTo(map).bindPopup(`<b>${escapeHtml(p.name)}</b>`); 
      } 
    }); 

    if (traceLayer) {
      traceLayer.clearLayers();
      if (tracedWorkerId && userTraces[tracedWorkerId] && userTraces[tracedWorkerId].length > 1) {
        const path = userTraces[tracedWorkerId].map(t => [t.lat, t.lon]);
        const polyline = L.polyline(path, { color: '#14b8a6', weight: 4, opacity: 0.8, dashArray: '5, 10' }).addTo(traceLayer);
        map.fitBounds(polyline.getBounds(), { padding: [40, 40] });
      }
    }
  }

  function checkWeather() {
    if (!isFancyMode) return; 
    if (group.length === 0) return; const person = group.find(p => p.lat !== null && p.lon !== null); if (!person) return;
    const now = Date.now(); if (now - lastWeatherFetch < 900000 && lastWeatherCoords) return;
    lastWeatherFetch = now; lastWeatherCoords = { lat: person.lat, lon: person.lon };
    fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?latitude=${person.lat}&longitude=${person.lon}&current_weather=true`, { timeout: 6000 }).then(res => res.json()).then(data => { if (data && data.current_weather) { const temp = data.current_weather.temperature; const wind = data.current_weather.windspeed; const wTemp = document.getElementById("wTemp"); const wWind = document.getElementById("wWind"); if (wTemp) wTemp.innerHTML = `${temp}&deg;C`; if (wWind) wWind.innerHTML = `${wind} km/h`; } }).catch(() => {});
  }

  function init() {
    applyVisualMode(); ensureNewUIElements();
    const addForm = document.getElementById("addForm");
    if (addForm) {
      addForm.addEventListener("submit", (e) => {
        e.preventDefault(); const nameEl = document.getElementById("nameInput"); const name = nameEl ? nameEl.value.trim() : ""; if (!name) return;
        const personId = uid(); if (!mySelfPersonId) mySelfPersonId = personId;
        const person = { id: personId, name, role: userRole, battery: currentBattery, inZone: false, height: pendingCapture ? (pendingCapture.height ?? 0) : 0, lat: pendingCapture ? pendingCapture.lat : null, lon: pendingCapture ? pendingCapture.lon : null, method: pendingCapture ? pendingCapture.method : "manual", updatedAt: new Date().toISOString() };
        group.push(person); syncToServer(); resetForm(); render();
      });
    }

    const captureBtn = document.getElementById("captureBtn"); if (captureBtn) captureBtn.addEventListener("click", capture);
    const setRefBtn = document.getElementById("setRefBtn"); if (setRefBtn) { setRefBtn.addEventListener("click", () => { const val = parseFloat(document.getElementById("referenceInput")?.value); if (!isNaN(val)) { globalReference = val; if (isSocketConnected) socket.emit('updateReference', val); render(); } }); }
    
    const rosterList = document.getElementById("rosterList");
    if (rosterList) {
      rosterList.addEventListener("click", (e) => {
        const id = e.target.dataset.id;
        if (e.target.closest(".track-btn")) { if (livePersonId === id) stopTracking(); else startTracking(); } 
        else if (e.target.closest(".trace-btn")) { if (tracedWorkerId === id) tracedWorkerId = null; else tracedWorkerId = id; render(); }
        else if (e.target.closest(".remove-btn")) { if (livePersonId === id) stopTracking(); socket.emit('removeMember', { personId: id, requestedByPersonId: mySelfPersonId, requesterRole: userRole }); }
        else if (e.target.closest(".promote-btn")) { const p = group.find(x => x.id === id); if (p) { p.role = 'sub-admin'; syncToServer(); } }
        else if (e.target.closest(".demote-btn")) { const p = group.find(x => x.id === id); if (p) { p.role = 'worker'; syncToServer(); } }
      });
    }

    const saveSettings = () => { settings.limit = parseFloat(document.getElementById("limitInput")?.value) || 2; settings.dropThreshold = parseFloat(document.getElementById("dropInput")?.value) || 1.5; settings.dropWindow = parseInt(document.getElementById("windowInput")?.value, 10) || 4; settings.ntfyTopic = document.getElementById("ntfyTopicInput")?.value.trim() || ""; settings.floorHeight = parseFloat(document.getElementById("floorInput")?.value) || 3.5; saveJSON(STORAGE.settings, settings); render(); };
    ["limitInput", "dropInput", "windowInput", "ntfyTopicInput", "floorInput"].forEach(id => document.getElementById(id)?.addEventListener("input", saveSettings));

    initMap(); initBarometer(); render();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
