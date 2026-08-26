/* ============================================================
   ALTIGUARD
   Group elevation tracking + sudden-drop alerting.

   Two modes:
   - Local mode (default): everything lives in this browser's
     localStorage. One device, manually logging readings for
     the group. Works fully offline once loaded.
   - Session mode (optional, needs firebase-config.js filled
     in): each phone joins a shared session and reports its
     own live GPS. Everyone sees everyone, and a drop anywhere
     alerts every connected phone. Needs an internet connection.
   ============================================================ */

(function () {
  "use strict";

  /* ---------------- storage (local mode) ---------------- */

  const STORAGE = {
    group: "altiguard_group_v1",
    settings: "altiguard_settings_v1",
    alerts: "altiguard_alerts_v1",
    lastName: "altiguard_last_name",
  };

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage unavailable or full — app still works for this session */
    }
  }

  /* ---------------- state ---------------- */

  let group = loadJSON(STORAGE.group, []); // local-mode roster
  let settings = loadJSON(STORAGE.settings, {
    limit: 2,
    dropThreshold: 1.5,
    dropWindow: 4,
  });
  let alerts = loadJSON(STORAGE.alerts, []);

  let manualMode = false;
  let pendingCapture = null; // { lat, lon, height, accuracy, method }

  // local-mode live tracking (one person, tracked from this device)
  let livePersonId = null;
  let watchId = null;
  let liveHistory = [];
  let liveSmoothBuffer = [];

  // session-mode state
  let sessionActive = false;
  let sessionPeople = []; // raw list from Firebase
  let sessionWatchId = null;
  let sessionLiveHistory = [];
  let sessionSmoothBuffer = [];
  let selfBaroRef;
  let selfLastHeight = null;
  let selfName = "";

  let baroSensor = null;
  let baroBaseline = null;

  let audioCtx = null;
  let bannerTimeout = null;

  /* ---------------- generic helpers ---------------- */

  function uid() {
    return "p_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function fmtSigned(n, digits) {
    return (n >= 0 ? "+" : "") + n.toFixed(digits);
  }

  function fmtHeight(h) {
    return typeof h === "number" ? h.toFixed(2) + " m" : "waiting for reading\u2026";
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
      case "pending": return "Waiting for first reading";
      default: return method || "Unknown";
    }
  }

  // Median-of-3 smoothing: rejects a single jittery GPS spike without
  // meaningfully lagging behind a real, sustained change in height.
  function pushSmoothed(buffer, rawValue) {
    buffer.push(rawValue);
    if (buffer.length > 3) buffer.shift();
    if (buffer.length < 3) return buffer.reduce((a, b) => a + b, 0) / buffer.length;
    const sorted = [...buffer].sort((a, b) => a - b);
    return sorted[1];
  }

  // Shared drop-detection: compares the smoothed current height against
  // the peak seen within the configured time window.
  function checkDropGeneric(historyArr, smoothedHeight, accuracy) {
    const now = Date.now();
    historyArr.push({ t: now, h: smoothedHeight });
    const windowMs = settings.dropWindow * 1000;
    while (historyArr.length && now - historyArr[0].t > windowMs + 2000) historyArr.shift();
    const inWindow = historyArr.filter((r) => now - r.t <= windowMs);
    if (inWindow.length < 2) return { triggered: false };
    const peak = Math.max(...inWindow.map((r) => r.h));
    const drop = peak - smoothedHeight;
    if (drop >= settings.dropThreshold) {
      historyArr.length = 0;
      historyArr.push({ t: now, h: smoothedHeight });
      const lowConfidence = typeof accuracy === "number" && accuracy > settings.dropThreshold * 2;
      return { triggered: true, drop, lowConfidence };
    }
    return { triggered: false };
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function bearingDegrees(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function compassLabel(deg) {
    const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return dirs[Math.round(deg / 22.5) % 16];
  }

  function distanceLabel(meters) {
    return meters < 1000 ? Math.round(meters) + " m" : (meters / 1000).toFixed(2) + " km";
  }

  /* ---------------- roster abstraction (local vs session) ---------------- */

  function getActiveRoster() {
    if (!sessionActive) return group;
    const now = Date.now();
    return sessionPeople.filter((p) => p.reference || now - (p.updatedAt || 0) < 45000);
  }

  function computeGroupMean(roster) {
    const real = roster.filter((p) => !p.reference && typeof p.height === "number");
    if (real.length === 0) return null;
    return real.reduce((a, p) => a + p.height, 0) / real.length;
  }

  function isPersonLive(p) {
    if (sessionActive) return !p.reference && Date.now() - (p.updatedAt || 0) < 45000;
    return p.id === livePersonId;
  }

  /* ---------------- audio + haptics ---------------- */

  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) { /* Web Audio unavailable — visual + vibration alerts still work */ }
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

  /* ---------------- barometer (shared by local + session tracking) ---------------- */

  function pressureToRelativeAltitude(currentHPa, baseHPa) {
    return 44330 * (1 - Math.pow(currentHPa / baseHPa, 1 / 5.255));
  }

  async function initBarometer() {
    if (!("Barometer" in window)) {
      setBaroStatus("off", "Not supported in this browser \u2014 using GPS altitude instead.");
      return;
    }
    try {
      if (navigator.permissions) {
        try {
          const status = await navigator.permissions.query({ name: "barometer" });
          if (status.state === "denied") {
            setBaroStatus("off", "Permission denied \u2014 using GPS altitude instead.");
            return;
          }
        } catch (e) { /* 'barometer' may not be queryable — try instantiating anyway */ }
      }
      // eslint-disable-next-line no-undef
      baroSensor = new Barometer({ frequency: 1 });
      baroSensor.addEventListener("reading", () => {
        if (baroBaseline === null) baroBaseline = baroSensor.pressure;
        setBaroStatus("on", "Active \u2014 refining live readings.");
      });
      baroSensor.addEventListener("error", (e) => {
        baroSensor = null;
        const denied = e.error && e.error.name === "NotAllowedError";
        setBaroStatus("off", denied ? "Permission denied \u2014 using GPS altitude instead." : "Unavailable on this device \u2014 using GPS altitude instead.");
      });
      baroSensor.start();
    } catch (e) {
      setBaroStatus("off", "Not available on this device \u2014 using GPS altitude instead.");
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
  function setSyncStatus(state, title) { setPill("syncPill", "syncLed", state, title); }

  /* ---------------- local mode: one-off capture ---------------- */

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

  /* ---------------- local mode: live tracking one roster member ---------------- */

  function startTracking(id) {
    if (!navigator.geolocation) {
      showAlertBanner("Geolocation isn\u2019t supported in this browser.");
      return;
    }
    stopTracking();
    unlockAudio();
    livePersonId = id;
    liveHistory = [];
    liveSmoothBuffer = [];
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
    liveSmoothBuffer = [];
    setLiveStatus(sessionActive ? "on" : "off");
    render();
  }

  function onLiveUpdate(pos) {
    const person = group.find((p) => p.id === livePersonId);
    if (!person) { stopTracking(); return; }

    const { latitude, longitude, altitude, accuracy } = pos.coords;
    setGpsStatus("on", "GPS fix acquired.");

    let method = "gps";
    let rawHeight;
    const baroDelta = currentBaroDelta();

    if (baroDelta !== null) {
      if (person._baroRef === undefined) {
        person._baroRef = (altitude !== null && altitude !== undefined ? altitude : person.height ?? 0) - baroDelta;
      }
      rawHeight = person._baroRef + baroDelta;
      method = "barometer";
    } else if (altitude !== null && altitude !== undefined) {
      rawHeight = altitude;
    } else {
      rawHeight = person.height ?? 0;
      method = "gps-no-altitude";
    }

    const smoothed = pushSmoothed(liveSmoothBuffer, rawHeight);

    person.lat = latitude;
    person.lon = longitude;
    person.height = smoothed;
    person.accuracy = accuracy;
    person.method = method;
    person.updatedAt = new Date().toISOString();

    const dropInfo = checkDropGeneric(liveHistory, smoothed, accuracy);
    if (dropInfo.triggered) triggerAlert(person, dropInfo.drop, false, dropInfo.lowConfidence);

    saveJSON(STORAGE.group, group);
    render();
  }

  function onLiveError(err) {
    showAlertBanner("Location error: " + (err.message || "unable to get position"));
  }

  /* ---------------- session mode: self tracking ---------------- */

  function startSelfSessionTracking() {
    if (!navigator.geolocation) {
      showAlertBanner("Geolocation isn\u2019t supported in this browser.");
      return;
    }
    if (sessionWatchId !== null) return;
    unlockAudio();
    sessionLiveHistory = [];
    sessionSmoothBuffer = [];
    selfBaroRef = undefined;
    sessionWatchId = navigator.geolocation.watchPosition(onSessionSelfUpdate, onLiveError, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
    });
    setLiveStatus("on", "Sharing your live position with the session.");
  }

  function stopSelfSessionTracking() {
    if (sessionWatchId !== null) {
      navigator.geolocation.clearWatch(sessionWatchId);
      sessionWatchId = null;
    }
    setLiveStatus("off");
  }

  function onSessionSelfUpdate(pos) {
    const { latitude, longitude, altitude, accuracy } = pos.coords;
    setGpsStatus("on", "GPS fix acquired.");

    let method = "gps";
    let rawHeight;
    const baroDelta = currentBaroDelta();

    if (baroDelta !== null) {
      if (selfBaroRef === undefined) {
        selfBaroRef = (altitude !== null && altitude !== undefined ? altitude : selfLastHeight ?? 0) - baroDelta;
      }
      rawHeight = selfBaroRef + baroDelta;
      method = "barometer";
    } else if (altitude !== null && altitude !== undefined) {
      rawHeight = altitude;
    } else {
      rawHeight = selfLastHeight ?? 0;
      method = "gps-no-altitude";
    }

    const smoothed = pushSmoothed(sessionSmoothBuffer, rawHeight);
    selfLastHeight = smoothed;

    window.AltiguardSync.pushSelfReading({ name: selfName, lat: latitude, lon: longitude, height: smoothed, accuracy, method });

    const dropInfo = checkDropGeneric(sessionLiveHistory, smoothed, accuracy);
    if (dropInfo.triggered) {
      triggerAlert({ id: window.AltiguardSync.selfId, name: selfName }, dropInfo.drop, false, dropInfo.lowConfidence);
      window.AltiguardSync.pushAlert({
        name: selfName,
        personId: window.AltiguardSync.selfId,
        drop: Number(dropInfo.drop.toFixed(2)),
        time: Date.now(),
        lowConfidence: dropInfo.lowConfidence,
      });
    }
  }

  /* ---------------- alerts ---------------- */

  function triggerAlert(person, dropAmount, isTest, lowConfidence) {
    const entry = {
      id: uid(),
      name: person ? person.name : "Test person",
      personId: person ? person.id : null,
      drop: Number(dropAmount.toFixed(2)),
      time: new Date().toISOString(),
      test: !!isTest,
      lowConfidence: !!lowConfidence,
    };
    alerts.unshift(entry);
    if (alerts.length > 50) alerts.length = 50;
    saveJSON(STORAGE.alerts, alerts);
    renderLog();
    const prefix = isTest ? "[TEST] " : lowConfidence ? "\u26a0 Possible drop (low GPS confidence) \u2014 " : "\u26a0 Sudden height drop \u2014 ";
    showAlertBanner(`${prefix}${entry.name} dropped ${entry.drop} m`);
    vibrate();
    beep();
    if (person) flashFigure(person.id);
  }

  // Effects for a drop detected on ANOTHER device, received via sync.
  function handleIncomingAlert(remote) {
    if (remote.personId && remote.personId === window.AltiguardSync.selfId) return; // echo of our own push
    const entry = {
      id: uid(),
      name: remote.name || "Someone",
      personId: remote.personId || null,
      drop: remote.drop,
      time: new Date(remote.time || Date.now()).toISOString(),
      test: false,
      lowConfidence: !!remote.lowConfidence,
    };
    alerts.unshift(entry);
    if (alerts.length > 50) alerts.length = 50;
    saveJSON(STORAGE.alerts, alerts);
    renderLog();
    const prefix = entry.lowConfidence ? "\u26a0 Possible drop (low GPS confidence) \u2014 " : "\u26a0 Sudden height drop \u2014 ";
    showAlertBanner(`${prefix}${entry.name} dropped ${entry.drop} m`);
    vibrate();
    beep();
    if (entry.personId) flashFigure(entry.personId);
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
    if 
