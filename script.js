/* ============================================================
   ALTIGUARD
   Group elevation tracking + sudden-drop alerting + ntfy push
   ============================================================ */

(function () {
  "use strict";

  const STORAGE = { settings: "altiguard_settings_v1" };

  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function loadJSON(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }

  let settings = loadJSON(STORAGE.settings, { 
    limit: 2, 
    dropThreshold: 1.5, 
    dropWindow: 4,
    ntfyTopic: "",
    floorHeight: 3.5 // NEW: Default floor height in meters
  });

  const socket = io();
  let currentRoom = "TEAM123"; 

  let group = [];
  let alerts = [];
  let globalReference = 0;
  
  // NEW: Site Status variables
  let isAlerting = false;
  let alertClearTimeout = null;

  // --- MAP VARIABLES ---
  let map = null;
  let markers = {};
  let hospitalLayer = null;
  let hospitalTimeout = null;

  socket.on('syncReference', (refValue) => {
    globalReference = refValue;
    const refInput = document.getElementById("referenceInput");
    if (refInput) refInput.value = refValue;
    render(); 
  });
   
  socket.emit('joinRoom', currentRoom);

  const joinRoomBtn = document.getElementById("joinRoomBtn");
  if (joinRoomBtn) {
    joinRoomBtn.addEventListener("click", () => {
      const codeInput = document.getElementById("groupCodeInput");
      const code = codeInput ? codeInput.value.trim() : "";
      if (code) {
        currentRoom = code;
        socket.emit('joinRoom', currentRoom);
        alerts = []; 
        stopTracking();
      }
    });
  }

  socket.on('syncGroup', (serverGroup) => {
    group = serverGroup;
    render();
  });

  socket.on('receiveAlert', (entry) => {
    alerts.unshift(entry);
    if (alerts.length > 50) alerts.length = 50;
    renderLog();
    showAlertBanner(`⚠️ Sudden drop — ${entry.name} dropped ${entry.drop} m`);
    vibrate();
    beep();
    if (entry.personId) flashFigure(entry.personId);
    
    // Trigger Site Status Alarm
    triggerSiteAlarm();
    
    if (window.Notification && Notification.permission === "granted") {
      new Notification(`⚠️ Drop Alert: ${entry.name}`, { body: `${entry.name} dropped ${entry.drop}m` });
    }
  });

  function syncToServer() {
    socket.emit('updateGroup', group);
  }

  // --- DYNAMIC UI INJECTORS ---
  // Safely injects the new HTML without you having to manually edit index.html
  function ensureNewUIElements() {
    // 1. Inject Summary Bar at the top of the main container
    if (!document.getElementById("summaryBar")) {
      const main = document.querySelector("main") || document.querySelector(".dashboard") || document.body;
      const bar = document.createElement("div");
      bar.id = "summaryBar";
      bar.className = "summary-bar";
      bar.innerHTML = `
        <div class="stat-box">
          <span class="stat-label">Active Personnel</span>
          <strong id="statActive">0 Tracked</strong>
        </div>
        <div class="stat-box">
          <span class="stat-label">Highest Elevation</span>
          <strong id="statHighest">--</strong>
        </div>
        <div class="stat-box">
          <span class="stat-label">System Status</span>
          <strong id="statStatus" class="status-secure">🟢 SECURE</strong>
        </div>
      `;
      main.insertBefore(bar, main.firstChild);
    }

    // 2. Inject Floor Height input into the settings panel
    if (!document.getElementById("floorInput")) {
      const winInput = document.getElementById("windowInput");
      if (winInput) {
        const wrapper = document.createElement("div");
        wrapper.style.marginTop = "15px";
        wrapper.innerHTML = `
          <label style="display:block; font-size:12px; font-weight:600; color:var(--text-dim); margin-bottom:5px;">Standard Floor Height (m)</label>
          <input type="number" id="floorInput" step="0.1" class="panel-input" value="${settings.floorHeight}">
        `;
        winInput.parentNode.insertBefore(wrapper, winInput.nextSibling);
      }
    }
  }

  function triggerSiteAlarm() {
    isAlerting = true;
    clearTimeout(alertClearTimeout);
    renderSummary(); 
    // Clear alarm automatically after 15 seconds
    alertClearTimeout = setTimeout(() => {
      isAlerting = false;
      renderSummary();
    }, 15000);
  }
   
  let manualMode = false;
  let pendingCapture = null;
  let livePersonId = null;
  let watchId = null;
  let liveHistory = [];
  let baroSensor = null;
  let baroBaseline = null; 
  let audioCtx = null;
  let bannerTimeout = null;

  let inactivityInterval = null;
  let lastMoveTime = null;
  let lastValidHeight = null;

  function uid() {
    return "p_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function fmtSigned(n, digits) {
    const v = n.toFixed(digits);
    return (n >= 0 ? "+" : "") + v;
  }

  function getGroupReference() {
    return globalReference;
  }

  function statusFor(rel) {
    if (rel > settings.limit) return "above";
    if (rel < -settings.limit) return "below";
    return "within";
  }

  function statusLabel(status) {
    return status === "within" ? "within limit" : status === "above" ? "above limit" : "below limit";
  }

  function methodLabelFor(method) {
    switch (method) {
      case "barometer": return "Barometer (live)";
      case "gps": return "GPS altitude";
      case "gps+barometer-ready": return "GPS altitude";
      case "gps-no-altitude": return "GPS (no altitude)";
      case "manual": return "Manual entry";
      default: return method || "Unknown";
    }
  }

  function niceStep(maxVal) {
    const rough = maxVal / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
    const norm = rough / mag;
    let step;
    if (norm < 1.5) step = 1 * mag;
    else if (norm < 3) step = 2 * mag;
    else if (norm < 7) step = 5 * mag;
    else step = 10 * mag;
    return step || 1;
  }

  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) {}
  }

  function beep() {
    if (!audioCtx) return;
    try {
      const pattern = [[880, 0.15], [0, 0.05], [660, 0.15], [0, 0.05], [880, 0.28]];
      let t = audioCtx.currentTime;
      pattern.forEach(([freq, dur]) => {
        if (freq > 0) {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = "square";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          osc.connect(gain).connect(audioCtx.destination);
          osc.start(t);
          osc.stop(t + dur + 0.02);
        }
        t += dur;
      });
    } catch (e) {}
  }

  function vibrate() {
    if (navigator.vibrate) {
      try { navigator.vibrate([200, 100, 200, 100, 400]); } catch (e) {}
    }
  }

  function pressureToRelativeAltitude(currentHPa, baseHPa) {
    return 44330 * (1 - Math.pow(currentHPa / baseHPa, 1 / 5.255));
  }

  async function initBarometer() {
    if (!("Barometer" in window)) {
      setBaroStatus("off", "Not supported in this browser — using GPS altitude instead.");
      return;
    }
    try {
      if (navigator.permissions) {
        try {
          const status = await navigator.permissions.query({ name: "barometer" });
          if (status.state === "denied") {
            setBaroStatus("off", "Permission denied — using GPS altitude instead.");
            return;
          }
        } catch (e) {}
      }
      baroSensor = new Barometer({ frequency: 1 });
      baroSensor.addEventListener("reading", () => {
        if (baroBaseline === null) baroBaseline = baroSensor.pressure;
        setBaroStatus("on", "Active — refining live readings.");
      });
      baroSensor.addEventListener("error", (e) => {
        baroSensor = null;
        const denied = e.error && e.error.name === "NotAllowedError";
        setBaroStatus("off", denied ? "Permission denied — using GPS altitude instead." : "Unavailable on this device — using GPS altitude instead.");
      });
      baroSensor.start();
    } catch (e) {
      setBaroStatus("off", "Not available on this device — using GPS altitude instead.");
    }
  }

  function currentBaroDelta() {
    if (baroSensor && baroBaseline !== null && typeof baroSensor.pressure === "number") {
      return pressureToRelativeAltitude(baroSensor.pressure, baroBaseline);
    }
    return null;
  }

  function setPill(pillId, ledId, state, title) {
    const pill = document.getElementById(pillId);
    const led = document.getElementById(ledId);
    if (!pill || !led) return;
    led.classList.remove("active", "warn", "danger");
    if (state === "on") led.classList.add("active");
    else if (state === "warn") led.classList.add("warn");
    else if (state === "danger") led.classList.add("danger");
    if (title) pill.title = title;
  }

  function setGpsStatus(state, title) { setPill("gpsPill", "gpsLed", state, title); }
  function setBaroStatus(state, title) { setPill("baroPill", "baroLed", state, title); }
  function setLiveStatus(state, title) { setPill("livePill", "liveLed", state, title); }

  function capture() {
    const readout = document.getElementById("captureReadout");
    if (!navigator.geolocation) {
      if (readout) readout.innerHTML = '<span class="readout-error">Geolocation isn\u2019t supported here — use manual entry.</span>';
      return;
    }
    unlockAudio();
    if (readout) readout.innerHTML = '<span class="readout-pending">Getting location\u2026</span>';

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, altitude, accuracy } = pos.coords;
        setGpsStatus("on", "GPS fix acquired.");

        if (altitude === null || altitude === undefined) {
          pendingCapture = { lat: latitude, lon: longitude, height: null, accuracy, method: "gps-no-altitude" };
          if (readout) readout.innerHTML = `<span class="readout-warn">No altitude from GPS. Switch to manual entry to set height.</span>`;
          updateAddButtonState();
          return;
        }

        pendingCapture = { lat: latitude, lon: longitude, height: altitude, accuracy, method: "gps" };
        if (readout) readout.innerHTML = `<span class="readout-ok">\u2713 ${altitude.toFixed(2)} m \u00b7 ${latitude.toFixed(5)}, ${longitude.toFixed(5)}</span>`;
        updateAddButtonState();
      },
      (err) => {
        if (readout) readout.innerHTML = `<span class="readout-error">${escapeHtml(err.message || "Could not get location")} — try manual entry.</span>`;
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  function hasValidPending() {
    if (manualMode) {
      const el = document.getElementById("manualHeight");
      const h = el ? parseFloat(el.value) : NaN;
      return !isNaN(h);
    }
    return !!(pendingCapture && pendingCapture.height !== null && pendingCapture.height !== undefined);
  }

  function updateAddButtonState() {
    const addBtn = document.getElementById("addBtn");
    if (addBtn) addBtn.disabled = !hasValidPending();
  }

  function resetForm() {
    const fields = ["nameInput", "workerPhoneInput", "manualHeight", "manualLat", "manualLon"];
    fields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    const readout = document.getElementById("captureReadout");
    if (readout) readout.innerHTML = "";
    pendingCapture = null;
    manualMode = false;
    const manualFields = document.getElementById("manualFields");
    if (manualFields) manualFields.hidden = true;
    const manualToggle = document.getElementById("manualToggle");
    if (manualToggle) manualToggle.textContent = "Enter manually";
    updateAddButtonState();
  }

  function startTracking(id) {
    if (!navigator.geolocation) {
      showAlertBanner("Geolocation isn't supported in this browser.");
      return;
    }
    stopTracking();
    unlockAudio();
    livePersonId = id;
    liveHistory = [];
    lastMoveTime = Date.now();
    lastValidHeight = null;

    watchId = navigator.geolocation.watchPosition(onLiveUpdate, onLiveError, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
    });
    setLiveStatus("on", "Live tracking a group member.");
    
    inactivityInterval = setInterval(() => {
      if (lastMoveTime && (Date.now() - lastMoveTime > 5 * 60 * 1000)) {
        showAlertBanner("⚠️ Man Down Warning: No movement detected for 5 minutes.");
        beep();
        vibrate();
      }
    }, 30000);
    
    render();
  }

  function stopTracking() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    if (inactivityInterval) clearInterval(inactivityInterval);
    livePersonId = null;
    liveHistory = [];
    setLiveStatus("off");
    render();
  }

  function onLiveUpdate(pos) {
    const person = group.find((p) => p.id === livePersonId);
    if (!person) { stopTracking(); return; }

    const { latitude, longitude, altitude, accuracy } = pos.coords;
    setGpsStatus("on", "GPS fix acquired.");

    let method = "gps";
    let height;
    const baroDelta = currentBaroDelta();

    if (baroDelta !== null) {
      if (person._baroRef === undefined) {
        person._baroRef = (altitude !== null && altitude !== undefined ? altitude : (person.height ?? 0)) - baroDelta;
      }
      height = person._baroRef + baroDelta;
      method = "barometer";
    } else if (altitude !== null && altitude !== undefined) {
      height = altitude;
    } else {
      height = person.height ?? 0;
      method = "gps-no-altitude";
    }

    if (lastValidHeight === null || Math.abs(lastValidHeight - height) > 0.5) {
      lastValidHeight = height;
      lastMoveTime = Date.now();
    }

    person.lat = latitude;
    person.lon = longitude;
    person.height = height;
    person.accuracy = accuracy;
    person.method = method;
    person.updatedAt = new Date().toISOString();

    checkDrop(person);
    syncToServer();
    render();
  }

  function onLiveError(err) {
    showAlertBanner("Location error: " + (err.message || "unable to get position"));
  }

  function checkDrop(person) {
    const now = Date.now();
    liveHistory.push({ t: now, h: person.height });
    const windowMs = settings.dropWindow * 1000;
    liveHistory = liveHistory.filter((r) => now - r.t <= windowMs + 2000);
    const inWindow = liveHistory.filter((r) => now - r.t <= windowMs);
    if (inWindow.length < 2) return;

    const peak = Math.max(...inWindow.map((r) => r.h));
    const drop = peak - person.height;
    if (drop >= settings.dropThreshold) {
      triggerAlert(person, drop, false);
      liveHistory = [{ t: now, h: person.height }];
    }
  }

  function triggerAlert(person, dropAmount, isTest) {
    const topicInput = document.getElementById("ntfyTopicInput");
    const activeTopic = topicInput ? topicInput.value.trim() : (settings.ntfyTopic || "");

    const entry = {
      id: uid(),
      name: person ? person.name : "Test person",
      phone: person ? person.phone : "",
      personId: person ? person.id : null,
      drop: Number(dropAmount.toFixed(2)),
      lat: person ? person.lat : null,
      lon: person ? person.lon : null,
      time: new Date().toISOString(),
      test: !!isTest,
      ntfyTopic: activeTopic
    };
    alerts.unshift(entry);
    if (alerts.length > 50) alerts.length = 50;
    socket.emit('triggerAlert', entry);
    renderLog();
    
    triggerSiteAlarm();
    
    showAlertBanner(`${isTest ? "[TEST] " : ""}⚠️ Sudden height drop — ${entry.name} dropped ${entry.drop} m`);
    vibrate();
    beep();
    if (person) flashFigure(person.id);
  }

  function showAlertBanner(msg) {
    const banner = document.getElementById("alertBanner");
    if (!banner) return;
    banner.textContent = msg;
    banner.classList.add("show");
    clearTimeout(bannerTimeout);
    bannerTimeout = setTimeout(() => banner.classList.remove("show"), 6000);
  }

  function flashFigure(id) {
    const el = document.querySelector(`.figure[data-person-id="${id}"]`);
    if (!el) return;
    el.classList.add("figure-flash");
    setTimeout(() => el.classList.remove("figure-flash"), 4000);
  }

  function render() {
    renderSummary(); 
    renderRoster();
    renderGraph();
    renderLog();
    renderMap(); 
  }

  // --- NEW: SITE SUMMARY BAR LOGIC ---
  function renderSummary() {
    const elActive = document.getElementById("statActive");
    const elHighest = document.getElementById("statHighest");
    const elStatus = document.getElementById("statStatus");
    if (!elActive) return;

    elActive.textContent = `${group.length} Personnel`;

    if (group.length > 0) {
      const highest = group.reduce((prev, curr) => (prev.height > curr.height) ? prev : curr);
      const relHeight = highest.height - getGroupReference();
      const floorH = settings.floorHeight || 3.5;
      const floorNum = Math.floor(relHeight / floorH);
      const floorLabel = floorNum >= 0 ? `Lvl ${floorNum}` : `Bsmnt ${Math.abs(floorNum)}`;
      
      elHighest.innerHTML = `${escapeHtml(highest.name)} <span style="color:var(--amber)">@ +${relHeight.toFixed(1)}m</span> (${floorLabel})`;
    } else {
      elHighest.textContent = "--";
    }

    if (isAlerting) {
      elStatus.className = "status-danger";
      elStatus.innerHTML = "🔴 FALL DETECTED";
      elStatus.style.animation = "pulseBorder 1s infinite alternate";
    } else {
      elStatus.className = "status-secure";
      elStatus.innerHTML = "🟢 SECURE";
      elStatus.style.animation = "none";
    }
  }

  function renderRoster() {
    const list = document.getElementById("rosterList");
    const emptyHint = document.getElementById("emptyHint");
    if (!list || !emptyHint) return;
    if (group.length === 0) {
      list.innerHTML = "";
      emptyHint.hidden = false;
      return;
    }
    emptyHint.hidden = true;
    const mean = getGroupReference();  
   
    list.innerHTML = group.map((p) => {
      const rel = p.height - mean;
      const status = statusFor(rel);
      const isLive = p.id === livePersonId;
      const coords = (p.lat !== null && p.lat !== undefined && p.lon !== null && p.lon !== undefined)
        ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : "No GPS coordinates";
      const phoneDisplay = p.phone ? `${escapeHtml(p.phone)} · ` : "";

      return `
      <li class="roster-item ${isLive ? "is-live" : ""}">
        <div class="roster-info">
          <strong>${escapeHtml(p.name)}</strong>
          <span class="roster-sub">${phoneDisplay}${p.height.toFixed(2)} m · ${methodLabelFor(p.method)}</span>
          <span class="roster-coords">${coords}</span>
        </div>
        <div class="roster-status status-${status}">${fmtSigned(rel, 2)} m<small>${statusLabel(status)}</small></div>
        <div class="roster-actions">
          <button class="mini-btn track-btn ${isLive ? "active" : ""}" data-id="${p.id}">${isLive ? "⏹ Stop" : "Track"}</button>
          <button class="mini-btn remove-btn" data-id="${p.id}" aria-label="Remove ${escapeHtml(p.name)}">✕</button>
        </div>
      </li>`;
    }).join("");
  }

  function figureSVG(x, y, status, isLive, name, rel, id) {
    const cls = `figure figure-${status}${isLive ? " figure-live" : ""}`;
    return `
    <g class="${cls}" data-person-id="${id}" style="--fx: ${x.toFixed(1)}px; --fy: ${y.toFixed(1)}px;">
      ${isLive ? '<circle class="live-halo" r="14"></circle>' : ""}
      <text class="figure-readout" x="0" y="-28" text-anchor="middle">${fmtSigned(rel, 2)}m</text>
      <circle class="figure-head" cx="0" cy="-14" r="6"></circle>
      <line class="figure-body" x1="0" y1="-8" x2="0" y2="10"></line>
      <line class="figure-arm" x1="0" y1="-3" x2="-9" y2="6"></line>
      <line class="figure-arm" x1="0" y1="-3" x2="9" y2="6"></line>
      <line class="figure-leg" x1="0" y1="10" x2="-8" y2="25"></line>
      <line class="figure-leg" x1="0" y1="10" x2="8" y2="25"></line>
      <text class="figure-label" x="0" y="39" text-anchor="middle">${escapeHtml(name)}</text>
    </g>`;
  }

  function renderGraph() {
    const svg = document.getElementById("graphSvg");
    if (!svg) return;
    const W = 640, H = 380;
    const marginL = 58, marginR = 20, marginT = 20, marginB = 46;
    const plotW = W - marginL - marginR;
    const plotH = H - marginT - marginB;
    const midY = marginT + plotH / 2;

    if (group.length === 0) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="graph-empty">Add people to see the elevation profile</text>`;
      return;
    }

    const mean = getGroupReference();  
    const rels = group.map((p) => p.height - mean);
    const maxAbs = Math.max(settings.limit * 1.2, ...rels.map((r) => Math.abs(r)), 1);
    const scale = (plotH / 2) / maxAbs;
    const step = niceStep(maxAbs);

    const parts = [];

    // --- NEW: DRAW HUMAN-READABLE FLOOR BANDS ---
    const floorH = settings.floorHeight || 3.5;
    const floorPx = floorH * scale;
    const startFloor = Math.floor(-maxAbs / floorH) - 1;
    const endFloor = Math.ceil(maxAbs / floorH) + 1;

    for (let f = startFloor; f <= endFloor; f++) {
      const yBot = midY - (f * floorH) * scale;
      const yTop = yBot - floorPx;

      // Ensure bands don't draw outside the graph borders
      const rectBot = Math.min(Math.max(yBot, marginT), marginT + plotH);
      const rectTop = Math.max(Math.min(yTop, marginT + plotH), marginT);
      const rectHeight = rectBot - rectTop;

      if (rectHeight > 0) {
        const bgClass = Math.abs(f) % 2 === 0 ? 'floor-even' : 'floor-odd';
        parts.push(`<rect x="${marginL}" y="${rectTop}" width="${plotW}" height="${rectHeight}" class="${bgClass}"></rect>`);
        
        // Add "Level X" label inside the band
        if (rectHeight > 15) {
          const labelStr = f >= 0 ? `Level ${f}` : `Bsmt ${Math.abs(f)}`;
          parts.push(`<text class="floor-label" x="${marginL + plotW - 5}" y="${rectTop + 14}" text-anchor="end">${labelStr}</text>`);
        }
      }
    }
    // -------------------------------------------

    for (let v = step; v <= maxAbs + 0.0001; v += step) {
      [v, -v].forEach((val) => {
        const y = midY - val * scale;
        if (y < marginT - 2 || y > marginT + plotH + 2) return;
        parts.push(`<line class="grid-line" x1="${marginL}" y1="${y.toFixed(1)}" x2="${marginL + plotW}" y2="${y.toFixed(1)}"></line>`);
        parts.push(`<text class="axis-label" x="${marginL - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end">${val > 0 ? "+" : ""}${val.toFixed(step < 1 ? 1 : 0)}</text>`);
      });
    }

    const limitYTop = midY - settings.limit * scale;
    const limitYBot = midY + settings.limit * scale;
    parts.push(`<line class="limit-line" x1="${marginL}" y1="${limitYTop.toFixed(1)}" x2="${marginL + plotW}" y2="${limitYTop.toFixed(1)}"></line>`);
    parts.push(`<line class="limit-line" x1="${marginL}" y1="${limitYBot.toFixed(1)}" x2="${marginL + plotW}" y2="${limitYBot.toFixed(1)}"></line>`);

    parts.push(`<line class="baseline" x1="${marginL}" y1="${midY.toFixed(1)}" x2="${marginL + plotW}" y2="${midY.toFixed(1)}"></line>`);
    parts.push(`<text class="baseline-label" x="${marginL + plotW}" y="${(midY - 8).toFixed(1)}" text-anchor="end">GROUP LEVEL · 0 m</text>`);
    parts.push(`<text class="axis-label" x="${marginL - 8}" y="${(midY + 3).toFixed(1)}" text-anchor="end">0</text>`);

    const n = group.length;
    group.forEach((p, i) => {
      const rel = p.height - mean;
      const x = marginL + (plotW * (i + 0.5)) / n;
      const y = midY - rel * scale;
      const status = statusFor(rel);
      const isLive = p.id === livePersonId;
      parts.push(figureSVG(x, y, status, isLive, p.name, rel, p.id));
    });

    svg.innerHTML = parts.join("");
  }

  function renderLog() {
    const list = document.getElementById("logList");
    const hint = document.getElementById("logEmptyHint");
    if (!list || !hint) return;
    if (alerts.length === 0) {
      list.innerHTML = "";
      hint.hidden = false;
      return;
    }
    hint.hidden = true;
    list.innerHTML = alerts.slice(0, 20).map((a) => {
      const time = new Date(a.time).toLocaleTimeString();
      return `<li class="log-item ${a.test ? "is-test" : ""}">
        <span class="log-time">${time}</span>
        <span class="log-text">${a.test ? "[TEST] " : ""}${escapeHtml(a.name)} dropped <strong>${a.drop} m</strong></span>
      </li>`;
    }).join("");
  }

  function initMap() {
    const mapEl = document.getElementById("map");
    if (!mapEl || typeof L === "undefined") return;
    
    map = L.map('map', {
      zoomControl: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      dragging: true
    }).setView([20.5937, 78.9629], 5);
    
    L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '&copy; OpenTopoMap'
    }).addTo(map);

    hospitalLayer = L.layerGroup().addTo(map);

    map.on('moveend', () => {
      clearTimeout(hospitalTimeout);
      hospitalTimeout = setTimeout(fetchHospitals, 1500); 
    });
  }

  function fetchHospitals() {
    if (!map || map.getZoom() < 11) return; 

    const bounds = map.getBounds();
    const S = bounds.getSouth();
    const W = bounds.getWest();
    const N = bounds.getNorth();
    const E = bounds.getEast();
    
    const query = `[out:json][timeout:10];node["amenity"="hospital"](${S},${W},${N},${E});out;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

    fetch(url)
      .then(res => res.json())
      .then(data => {
        hospitalLayer.clearLayers(); 
        
        if (data && data.elements) {
          data.elements.forEach(item => {
            if (item.lat && item.lon) {
              const name = (item.tags && item.tags.name) ? item.tags.name : "Emergency Hospital";
              
              const icon = L.divIcon({
                className: '', 
                html: `<div style="background: #0a0f1c; border: 3px solid #ff4d5e; border-radius: 50%; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; font-size: 24px; box-shadow: 0 0 15px #ff4d5e80;">🏥</div>`,
                iconSize: [40, 40],
                iconAnchor: [20, 20],
                popupAnchor: [0, -20]
              });

              const marker = L.marker([item.lat, item.lon], { icon: icon });
              marker.bindPopup(`<b style="color: #ff4d5e; font-family: var(--font-display);">🏥 ${escapeHtml(name)}</b><br><span style="font-family: var(--font-mono); font-size: 12px; color: var(--text-dim);">Emergency Facility</span>`);
              hospitalLayer.addLayer(marker);
            }
          });
        }
      })
      .catch(err => console.error("Hospital Fetch Error:", err));
  }

  function renderMap() {
    if (!map) return;
    
    const currentIds = group.map(p => p.id);
    for (let id in markers) {
      if (!currentIds.includes(id)) {
        map.removeLayer(markers[id]);
        delete markers[id];
      }
    }

    const crosshairIcon = L.divIcon({
      className: '',
      html: `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#f5a623" stroke-width="2" style="filter: drop-shadow(0 0 5px #f5a623);">
               <circle cx="12" cy="12" r="6"></circle>
               <circle cx="12" cy="12" r="2" fill="#f5a623"></circle>
               <line x1="12" y1="0" x2="12" y2="24"></line>
               <line x1="0" y1="12" x2="24" y2="12"></line>
             </svg>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
      popupAnchor: [0, -18]
    });

    let bounds = [];
    group.forEach(p => {
      if (p.lat !== null && p.lon !== null && p.lat !== undefined && p.lon !== undefined) {
        const latlng = [p.lat, p.lon];
        bounds.push(latlng);
        
        if (markers[p.id]) {
          markers[p.id].setLatLng(latlng);
          markers[p.id].getPopup().setContent(`<b>${escapeHtml(p.name)}</b><br>${p.height.toFixed(2)}m`);
        } else {
          const marker = L.marker(latlng, { icon: crosshairIcon }).addTo(map);
          marker.bindPopup(`<b>${escapeHtml(p.name)}</b><br>${p.height.toFixed(2)}m`);
          markers[p.id] = marker;
        }
      }
    });

    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    }
  }

  function init() {
    ensureNewUIElements(); // Builds the new UI chunks safely!

    const limitIn = document.getElementById("limitInput");
    const dropIn = document.getElementById("dropInput");
    const winIn = document.getElementById("windowInput");
    const topicIn = document.getElementById("ntfyTopicInput");
    const floorIn = document.getElementById("floorInput"); // New setting

    if (limitIn) limitIn.value = settings.limit;
    if (dropIn) dropIn.value = settings.dropThreshold;
    if (winIn) winIn.value = settings.dropWindow;
    if (topicIn) topicIn.value = settings.ntfyTopic || "";
    if (floorIn) floorIn.value = settings.floorHeight || 3.5;

    const addForm = document.getElementById("addForm");
    if (addForm) {
      addForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const nameEl = document.getElementById("nameInput");
        const phoneEl = document.getElementById("workerPhoneInput");
        const name = nameEl ? nameEl.value.trim() : "";
        const phone = phoneEl ? phoneEl.value.trim() : "";
        if (!name) return;

        let height = 0;
        let lat = null;
        let lon = null;
        let accuracy = null;
        let method = "manual";

        if (manualMode) {
          const hEl = document.getElementById("manualHeight");
          const latEl = document.getElementById("manualLat");
          const lonEl = document.getElementById("manualLon");
          height = hEl ? parseFloat(hEl.value) : 0;
          lat = (latEl && latEl.value) ? parseFloat(latEl.value) : null;
          lon = (lonEl && lonEl.value) ? parseFloat(lonEl.value) : null;
          method = "manual";
        } else if (pendingCapture) {
          height = pendingCapture.height ?? 0;
          lat = pendingCapture.lat;
          lon = pendingCapture.lon;
          accuracy = pendingCapture.accuracy;
          method = pendingCapture.method;
        }

        const person = {
          id: uid(),
          name,
          phone,
          height,
          lat,
          lon,
          accuracy,
          method,
          updatedAt: new Date().toISOString()
        };

        group.push(person);
        syncToServer();
        resetForm();
        render();
      });
    }

    const captureBtn = document.getElementById("captureBtn");
    if (captureBtn) captureBtn.addEventListener("click", capture);

    const manualToggle = document.getElementById("manualToggle");
    if (manualToggle) {
      manualToggle.addEventListener("click", () => {
        manualMode = !manualMode;
        const manualFields = document.getElementById("manualFields");
        if (manualFields) manualFields.hidden = !manualMode;
        manualToggle.textContent = manualMode ? "Use GPS capture" : "Enter manually";
        updateAddButtonState();
      });
    }

    const manualHeight = document.getElementById("manualHeight");
    if (manualHeight) manualHeight.addEventListener("input", updateAddButtonState);

    const setRefBtn = document.getElementById("setRefBtn");
    if (setRefBtn) {
      setRefBtn.addEventListener("click", () => {
        const refEl = document.getElementById("referenceInput");
        const val = refEl ? parseFloat(refEl.value) : 0;
        if (!isNaN(val)) {
          globalReference = val;
          socket.emit('updateReference', val);
          render();
        }
      });
    }

    const testAlertBtn = document.getElementById("testAlertBtn");
    if (testAlertBtn) {
      testAlertBtn.addEventListener("click", () => {
        triggerAlert(null, 1.80, true);
      });
    }

    const rosterList = document.getElementById("rosterList");
    if (rosterList) {
      rosterList.addEventListener("click", (e) => {
        const trackBtn = e.target.closest(".track-btn");
        const removeBtn = e.target.closest(".remove-btn");
        if (trackBtn) {
          const id = trackBtn.dataset.id;
          if (livePersonId === id) stopTracking();
          else startTracking(id);
        } else if (removeBtn) {
          const id = removeBtn.dataset.id;
          if (livePersonId === id) stopTracking();
          group = group.filter(p => p.id !== id);
          syncToServer();
          render();
        }
      });
    }

    const saveSettings = () => {
      if (limitIn) settings.limit = parseFloat(limitIn.value) || 2;
      if (dropIn) settings.dropThreshold = parseFloat(dropIn.value) || 1.5;
      if (winIn) settings.dropWindow = parseInt(winIn.value, 10) || 4;
      if (topicIn) settings.ntfyTopic = topicIn.value.trim();
      if (floorIn) settings.floorHeight = parseFloat(floorIn.value) || 3.5;
      saveJSON(STORAGE.settings, settings);
      render();
    };

    [limitIn, dropIn, winIn, topicIn, floorIn].forEach(input => {
      if (input) input.addEventListener("input", saveSettings);
    });

    initMap();       // Initialize Leaflet Map
    initBarometer(); // Initialize Barometer
    render();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
