/* ============================================================
   ALTIGUARD — Firebase config
   ============================================================
   This file turns on optional real-time, multi-phone sync
   (Section 6 of README.md). Until you fill it in, Altiguard
   runs perfectly well in local (single-device) mode — this
   file being empty is not an error.

   HOW TO TURN ON SYNC:
   1. Follow README.md, Section 6, to create a free Firebase
      project and a Realtime Database.
   2. Firebase will give you a config object that looks like
      the one commented out below.
   3. Replace the `null` below with that object (uncomment the
      example and fill in your own values, or paste your own).
   4. Save this file and re-upload it to your GitHub repo.

   Example of a FILLED-IN config (yours will have real values,
   not these placeholders):

   window.ALTIGUARD_FIREBASE_CONFIG = {
     apiKey: "AIzaSyD-your-real-key-here",
     authDomain: "your-project.firebaseapp.com",
     databaseURL: "https://your-project-default-rtdb.firebaseio.com",
     projectId: "your-project",
     storageBucket: "your-project.appspot.com",
     messagingSenderId: "123456789012",
     appId: "1:123456789012:web:abcdef1234567890"
   };

   `databaseURL` is the one field Altiguard actually needs
   (along with apiKey) — but it's fine to paste the whole
   object Firebase gives you, extra fields are simply ignored.
   ============================================================ */

window.ALTIGUARD_FIREBASE_CONFIG = null;
