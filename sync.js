/* ============================================================
   ALTIGUARD SYNC
   Optional real-time multi-device layer, built on Firebase
   Realtime Database. Completely inert if firebase-config.js
   hasn't been filled in — Altiguard then just runs local-only.

   This file only ever talks to the one Firebase project the
   site owner configures. Nothing goes to Anthropic or anywhere
   else.
   ============================================================ */

(function (global) {
  "use strict";

  const cfg = global.ALTIGUARD_FIREBASE_CONFIG;

  const Sync = {
    connected: false,
    sessionCode: null,
    selfId: null,
    onUpdate: null,  // callback(remotePeopleArray)
    onAlert: null,   // callback(alertObject)
    onStatus: null,  // callback(state, message) — state: 'connected' | 'disconnected' | 'error' | 'pending'
  };

  let app = null;
  let db = null;
  let peopleRef = null;
  let alertsRef = null;
  let selfRef = null;
  let presenceTimer = null;

  function available() {
    return !!(cfg && cfg.apiKey && cfg.databaseURL && global.firebase && global.firebase.database);
  }
  Sync.isAvailable = available;

  function fail(msg) {
    Sync.connected = false;
    if (Sync.onStatus) Sync.onStatus("error", msg);
  }

  function randomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
    let out = "";
    for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function getSelfId() {
    let id = null;
    try { id = localStorage.getItem("altiguard_self_id"); } catch (e) { /* ignore */ }
    if (!id) {
      id = "u_" + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem("altiguard_self_id", id); } catch (e) { /* ignore */ }
    }
    return id;
  }

  function ensureApp() {
    if (app && db) return true;
    if (!available()) return false;
    try {
      app = global.firebase.apps && global.firebase.apps.length ? global.firebase.app() : global.firebase.initializeApp(cfg);
      db = global.firebase.database();
      return true;
    } catch (e) {
      fail("Could not start sync: " + e.message);
      return false;
    }
  }

  function cleanupListeners() {
    try { if (peopleRef) peopleRef.off(); } catch (e) { /* ignore */ }
    try { if (alertsRef) alertsRef.off(); } catch (e) { /* ignore */ }
    clearInterval(presenceTimer);
    presenceTimer = null;
  }

  Sync.createSession = function (name) {
    if (!ensureApp()) { fail("Sync isn't configured yet."); return; }
    joinInternal(randomCode(), name);
  };

  Sync.joinSession = function (code, name) {
    if (!ensureApp()) { fail("Sync isn't configured yet."); return; }
    if (!code || code.trim().length < 3) { fail("Enter the session code first."); return; }
    joinInternal(code.trim().toUpperCase(), name);
  };

  function joinInternal(code, name) {
    Sync.leaveSession();
    if (Sync.onStatus) Sync.onStatus("pending", "Connecting to " + code + "\u2026");

    Sync.selfId = getSelfId();
    Sync.sessionCode = code;
    peopleRef = db.ref("sessions/" + code + "/people");
    alertsRef = db.ref("sessions/" + code + "/alerts");
    selfRef = peopleRef.child(Sync.selfId);

    selfRef
      .set({ name: name, height: null, lat: null, lon: null, accuracy: null, method: "pending", online: true, updatedAt: Date.now() })
      .then(() => {
        try { selfRef.onDisconnect().update({ online: false }); } catch (e) { /* not fatal */ }
        Sync.connected = true;
        if (Sync.onStatus) Sync.onStatus("connected", "Connected \u2014 session " + code);
        presenceTimer = setInterval(() => {
          if (selfRef) selfRef.child("lastPing").set(Date.now()).catch(() => {});
        }, 15000);
      })
      .catch((e) => fail("Could not join session: " + e.message));

    peopleRef.on(
      "value",
      (snap) => {
        const val = snap.val() || {};
        const list = Object.keys(val).map((id) => Object.assign({ id }, val[id]));
        if (Sync.onUpdate) Sync.onUpdate(list);
      },
      (e) => fail("Sync read failed: " + e.message)
    );

    const startAt = Date.now() - 5000;
    alertsRef.limitToLast(20).on("child_added", (snap) => {
      const a = snap.val();
      if (a && a.time >= startAt && Sync.onAlert) Sync.onAlert(a);
    });
  }

  Sync.pushSelfReading = function (data) {
    if (!Sync.connected || !selfRef) return;
    selfRef.update(Object.assign({}, data, { updatedAt: Date.now(), online: true })).catch((e) => {
      fail("Sync write failed: " + e.message);
    });
  };

  Sync.pushAlert = function (alert) {
    if (!Sync.connected || !alertsRef) return;
    alertsRef.push(alert).catch(() => { /* non-fatal — the alert still shows locally */ });
  };

  Sync.addReferencePoint = function (name, height) {
    if (!Sync.connected || !peopleRef) return;
    const id = "ref_" + Math.random().toString(36).slice(2, 9);
    peopleRef
      .child(id)
      .set({ name: name, height: height, lat: null, lon: null, method: "manual", reference: true, online: true, updatedAt: Date.now() })
      .catch((e) => fail("Could not add reference point: " + e.message));
  };

  Sync.leaveSession = function () {
    if (selfRef) { try { selfRef.remove(); } catch (e) { /* ignore */ } }
    cleanupListeners();
    peopleRef = null;
    alertsRef = null;
    selfRef = null;
    Sync.connected = false;
    Sync.sessionCode = null;
  };

  global.AltiguardSync = Sync;
})(window);
