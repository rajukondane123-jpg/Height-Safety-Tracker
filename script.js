/* ============================================================
   ALTIGUARD
   Group elevation tracking + sudden-drop alerting.
   Pure client-side: everything lives in localStorage, nothing
   is sent anywhere. Safe to host as a static site (GitHub Pages).
   ============================================================ */

(function () {
  "use strict";

  /* ---------------- storage ---------------- */

  const STORAGE = {
    // --- REAL-TIME NETWORKING ---
  const socket = io();
  let currentRoom = "TEAM123"; 

  let group = [];
  let settings = { limit: 2, dropThreshold: 1.5, dropWindow: 4 };
  let alerts = [];

  // Ask server to join default room on load
  socket.emit('joinRoom', currentRoom);

  // Listen for the button click to change rooms
  document.getElementById("joinRoomBtn").addEventListener("click", () => {
    const code = document.getElementById("groupCodeInput").value.trim();
    if (code) {
      currentRoom = code;
      socket.emit('joinRoom', currentRoom);
      alerts = []; // clear local alerts on room switch
      stopTracking();
      alert(`Joined group: ${currentRoom}`);
    }
  });

  // When server sends new group data (someone else moved or joined)
  socket.on('syncGroup', (serverGroup) => {
    group = serverGroup;
    render();
  });

  // When someone else's phone triggers a drop alert
  socket.on('receiveAlert', (entry) => {
    alerts.unshift(entry);
    if (alerts.length > 50) alerts.length = 50;
    renderLog();
    showAlertBanner(`⚠️ Sudden drop — ${entry.name} dropped ${entry.drop} m`);
    vibrate();
    beep();
    if (entry.personId) flashFigure(entry.personId);
  });

  // Helper to send data to server instead of localStorage
  function syncToServer() {
    socket.emit('updateGroup', group);
  }
   
  let manualMode = false;
  let pendingCapture = null; // { lat, lon, height, accuracy, method }

  let livePersonId = null;
  let watchId = null;
  let liveHistory = []; // [{ t, h }] for the live-tracked person

  let baroSensor = null;
  let baroBaseline = null; // reference pressure (hPa) captured at start

  let audioCtx = null;
  let bannerTimeout = null;

  /* ---------------- helpers ---------------- */

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

  function computeGroupMean() {
    if (group.length === 0) return null;
    const sum = group.reduce((acc, p) => acc + p.height, 0);
    return sum / group.length;
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

  /* ---------------- audio + haptics ---------------- */

  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) {
      /* Web Audio unavailable — visual + vibration alerts still work */
    }
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
    } catch (e) { /* ignore */ }
  }

  function vibrate() {
    if (navigator.vibrate) {
      try { navigator.vibrate([200, 100, 200, 100, 400]); } catch (e) { /* ignore */ }
    }
  }

  /* ---------------- barometer ---------------- */

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
        } catch (e) { /* 'barometer' may not be queryable — try instantiating anyway */ }
      }
      // eslint-disable-next-line no-undef
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

  /* ---------------- status pills ---------------- */

  function setPill(pillId, ledId, state, title) {
    const pill = document.getElementById(pillId);
    const led = document.getElementById(ledId);
    led.classList.remove("active", "warn", "danger");
    if (state === "on") led.classList.add("active");
    else if (state === "warn") led.classList.add("warn");
    else if (state === "danger") led.classList.add("danger");
    if (title) pill.title = title;
  }

  function setGpsStatus(state, title) { setPill("gpsPill", "gpsLed", state, title); }
  function setBaroStatus(state, title) { setPill("baroPill", "baroLed", state, title); }
  function setLiveStatus(state, title) { setPill("livePill", "liveLed", state, title); }

  /* ---------------- capture (one-off) ---------------- */

  function capture() {
    const readout = document.getElementById("captureReadout");
    if (!navigator.geolocation) {
      readout.innerHTML = '<span class="readout-error">Geolocation isn\u2019t supported here — use manual entry.</span>';
      return;
    }
    unlockAudio();
    readout.innerHTML = '<span class="readout-pending">Getting location\u2026</span>';

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, altitude, accuracy } = pos.coords;
        setGpsStatus("on", "GPS fix acquired.");

        if (altitude === null || altitude === undefined) {
          pendingCapture = { lat: latitude, lon: longitude, height: null, accuracy, method: "gps-no-altitude" };
          readout.innerHTML = `<span class="readout-warn">No altitude from GPS (common indoors). Got lat ${latitude.toFixed(5)}, lon ${longitude.toFixed(5)}. Switch to manual entry to set a height.</span>`;
          updateAddButtonState();
          return;
        }

        pendingCapture = { lat: latitude, lon: longitude, height: altitude, accuracy, method: "gps" };
        readout.innerHTML = `<span class="readout-ok">\u2713 ${altitude.toFixed(2)} m \u00b7 ${latitude.toFixed(5)}, ${longitude.toFixed(5)} \u00b7 \u00b1${accuracy ? accuracy.toFixed(0) : "?"} m</span>`;
        updateAddButtonState();
      },
      (err) => {
        readout.innerHTML = `<span class="readout-error">${escapeHtml(err.message || "Could not get location")} \u2014 try manual entry.</span>`;
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  function hasValidPending() {
    if (manualMode) {
      const h = parseFloat(document.getElementById("manualHeight").value);
      return !isNaN(h);
    }
    return !!(pendingCapture && pendingCapture.height !== null && pendingCapture.height !== undefined);
  }

  function updateAddButtonState() {
    document.getElementById("addBtn").disabled = !hasValidPending();
  }

  function resetForm() {
    document.getElementById("nameInput").value = "";
    document.getElementById("manualHeight").value = "";
    document.getElementById("manualLat").value = "";
    document.getElementById("manualLon").value = "";
    document.getElementById("captureReadout").innerHTML = "";
    pendingCapture = null;
    manualMode = false;
    document.getElementById("manualFields").hidden = true;
    document.getElementById("manualToggle").textContent = "Enter manually";
    updateAddButtonState();
  }

  /* ---------------- live tracking ---------------- */

  function startTracking(id) {
    if (!navigator.geolocation) {
      showAlertBanner("Geolocation isn\u2019t supported in this browser.");
      return;
    }
    stopTracking();
    unlockAudio();
    livePersonId = id;
    liveHistory = [];
    watchId = navigator.geolocation.watchPosition(onLiveUpdate, onLiveError, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
    });
    setLiveStatus("on", "Live tracking a group member.");
    render();
  }

  function stopTracking() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
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

    person.lat = latitude;
    person.lon = longitude;
    person.height = height;
    person.accuracy = accuracy;
    person.method = method;
    person.updatedAt = new Date().toISOString();

    checkDrop(person);
    saveJSON(STORAGE.group, group);
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

  /* ---------------- alerts ---------------- */

  function triggerAlert(person, dropAmount, isTest) {
    const entry = {
      id: uid(),
      name: person ? person.name : "Test person",
      personId: person ? person.id : null,
      drop: Number(dropAmount.toFixed(2)),
      time: new Date().toISOString(),
      test: !!isTest,
    };
    alerts.unshift(entry);
    if (alerts.length > 50) alerts.length = 50;
    saveJSON(STORAGE.alerts, alerts);
    renderLog();
    showAlertBanner(`${isTest ? "[TEST] " : ""}\u26a0 Sudden height drop \u2014 ${entry.name} dropped ${entry.drop} m`);
    vibrate();
    beep();
    if (person) flashFigure(person.id);
  }

  function showAlertBanner(msg) {
    const banner = document.getElementById("alertBanner");
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

  /* ---------------- rendering ---------------- */

  function render() {
    renderRoster();
    renderGraph();
    renderLog();
  }

  function renderRoster() {
    const list = document.getElementById("rosterList");
    const emptyHint = document.getElementById("emptyHint");
    if (group.length === 0) {
      list.innerHTML = "";
      emptyHint.hidden = false;
      return;
    }
    emptyHint.hidden = true;
    const mean = computeGroupMean();

    list.innerHTML = group.map((p) => {
      const rel = p.height - mean;
      const status = statusFor(rel);
      const isLive = p.id === livePersonId;
      const coords = (p.lat !== null && p.lat !== undefined && p.lon !== null && p.lon !== undefined)
        ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : "No GPS coordinates";

      return `
      <li class="roster-item ${isLive ? "is-live" : ""}">
        <div class="roster-info">
          <strong>${escapeHtml(p.name)}</strong>
          <span class="roster-sub">${p.height.toFixed(2)} m \u00b7 ${methodLabelFor(p.method)}</span>
          <span class="roster-coords">${coords}</span>
        </div>
        <div class="roster-status status-${status}">${fmtSigned(rel, 2)} m<small>${statusLabel(status)}</small></div>
        <div class="roster-actions">
          <button class="mini-btn track-btn ${isLive ? "active" : ""}" data-id="${p.id}">${isLive ? "\u23f9 Stop" : "\ud83c\udfaf Track"}</button>
          <button class="mini-btn remove-btn" data-id="${p.id}" aria-label="Remove ${escapeHtml(p.name)}">\u2715</button>
        </div>
      </li>`;
    }).join("");
  }

  function figureSVG(x, y, status, isLive, name, rel, id) {
    const cls = `figure figure-${status}${isLive ? " figure-live" : ""}`;
    return `
    <g class="${cls}" data-person-id="${id}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
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
    const W = 640, H = 380;
    const marginL = 58, marginR = 20, marginT = 20, marginB = 46;
    const plotW = W - marginL - marginR;
    const plotH = H - marginT - marginB;
    const midY = marginT + plotH / 2;

    if (group.length === 0) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="graph-empty">Add people to see the elevation profile</text>`;
      return;
    }

    const mean = computeGroupMean();
    const rels = group.map((p) => p.height - mean);
    const maxAbs = Math.max(settings.limit * 1.2, ...rels.map((r) => Math.abs(r)), 1);
    const scale = (plotH / 2) / maxAbs;
    const step = niceStep(maxAbs);

    const parts = [];

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
    parts.push(`<text class="baseline-label" x="${marginL + plotW}" y="${(midY - 8).toFixed(1)}" text-anchor="end">GROUP LEVEL \u00b7 0 m</text>`);
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

  /* ---------------- wiring ---------------- */

  function init() {
    document.getElementById("limitInput").value = settings.limit;
    document.getElementById("dropInput").value = settings.dropThreshold;
    document.getElementById("windowInput").value = settings.dropWindow;

    setGpsStatus(navigator.geolocation ? "off" : "danger", navigator.geolocation ? "Not yet used." : "Not supported in this browser.");
    setBaroStatus("off", "Checking\u2026");
    setLiveStatus("off");
    initBarometer();

    document.getElementById("captureBtn").addEventListener("click", capture);

    document.getElementById("manualToggle").addEventListener("click", () => {
      manualMode = !manualMode;
      document.getElementById("manualFields").hidden = !manualMode;
      document.getElementById("manualToggle").textContent = manualMode ? "Use GPS instead" : "Enter manually";
      updateAddButtonState();
    });

    document.getElementById("manualHeight").addEventListener("input", updateAddButtonState);

    document.getElementById("addForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = document.getElementById("nameInput").value.trim();
      if (!name) return;

      let personData;
      if (manualMode) {
        const h = parseFloat(document.getElementById("manualHeight").value);
        if (isNaN(h)) return;
        const lat = parseFloat(document.getElementById("manualLat").value);
        const lon = parseFloat(document.getElementById("manualLon").value);
        personData = { lat: isNaN(lat) ? null : lat, lon: isNaN(lon) ? null : lon, height: h, accuracy: null, method: "manual" };
      } else {
        if (!pendingCapture || pendingCapture.height === null || pendingCapture.height === undefined) return;
        personData = pendingCapture;
      }

      group.push({
        id: uid(),
        name,
        lat: personData.lat,
        lon: personData.lon,
        height: personData.height,
        accuracy: personData.accuracy,
        method: personData.method,
        addedAt: new Date().toISOString(),
      });
      saveJSON(STORAGE.group, group);
      resetForm();
      render();
    });

    document.getElementById("rosterList").addEventListener("click", (e) => {
      const trackBtn = e.target.closest(".track-btn");
      const removeBtn = e.target.closest(".remove-btn");
      if (trackBtn) {
        const id = trackBtn.dataset.id;
        if (livePersonId === id) stopTracking(); else startTracking(id);
      } else if (removeBtn) {
        const id = removeBtn.dataset.id;
        if (livePersonId === id) stopTracking();
        group = group.filter((p) => p.id !== id);
        saveJSON(STORAGE.group, group);
        render();
      }
    });

    document.getElementById("limitInput").addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v) && v > 0) { settings.limit = v; saveJSON(STORAGE.settings, settings); render(); }
    });
    document.getElementById("dropInput").addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v) && v > 0) { settings.dropThreshold = v; saveJSON(STORAGE.settings, settings); }
    });
    document.getElementById("windowInput").addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v) && v > 0) { settings.dropWindow = v; saveJSON(STORAGE.settings, settings); }
    });

    document.getElementById("testAlertBtn").addEventListener("click", () => {
      unlockAudio();
      const person = group.find((p) => p.id === livePersonId) || group[0] || null;
      triggerAlert(person, Math.max(settings.dropThreshold, 1.5) + 0.3, true);
    });

    document.getElementById("exportBtn").addEventListener("click", () => {
      const data = JSON.stringify({ group, settings, alerts, exportedAt: new Date().toISOString() }, null, 2);
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `altiguard-export-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    document.getElementById("clearBtn").addEventListener("click", () => {
      if (!confirm("Clear the entire group? This cannot be undone.")) return;
      stopTracking();
      group = [];
      saveJSON(STORAGE.group, group);
      render();
    });

    render();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
