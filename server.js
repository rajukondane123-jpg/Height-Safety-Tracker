/**
 * =========================================================
 * ALTIGUARD - SERVER.JS (FROM SCRATCH)
 * =========================================================
 * Handles:
 * - Admin Group Creation
 * - Live Auto-Latitude/Longitude & Elevation Syncing
 * - Member joining & map coordinate broadcasting
 */

const express = require('express');
const app = express();
const http = require('http').createServer(app);

// Setup Socket.io for live data transfer
const io = require('socket.io')(http, {
  cors: { origin: "*" }
});

app.use(express.static(__dirname));

// Database objects to hold our live groups and baselines
const groups = {}; // Format: { "GROUP123": { adminId: "socket_id", members: [] } }
const groupBaselines = {}; // Format: { "GROUP123": 0 }

io.on('connection', (socket) => {
  let currentGroup = null;

  // 1. ADMIN CREATES GROUP
  socket.on('createGroup', (groupCode) => {
    const code = (groupCode || "TEAM123").toUpperCase().trim();
    
    // Leave previous group if switching
    if (currentGroup) socket.leave(currentRoom);
    
    currentGroup = code;
    socket.join(code);

    // Initialize group if it doesn't exist
    if (!groups[code]) {
      groups[code] = {
        adminId: socket.id,
        members: []
      };
    }
    
    if (groupBaselines[code] === undefined) {
      groupBaselines[code] = 0;
    }

    // Tell the frontend this user is the Admin
    socket.emit('roleAssigned', { role: 'admin', groupCode: code });
    socket.emit('syncGroup', groups[code].members);
    socket.emit('syncBaseline', groupBaselines[code]);
    
    console.log(`[GROUP CREATED] ${code} by Admin ${socket.id}`);
  });

  // 2. WORKER JOINS GROUP
  socket.on('joinGroup', (groupCode) => {
    const code = (groupCode || "").toUpperCase().trim();
    
    if (!groups[code]) {
      socket.emit('groupError', 'This group code does not exist.');
      return;
    }

    if (currentGroup) socket.leave(currentGroup);
    currentGroup = code;
    socket.join(code);

    // Check if joining socket is the original admin
    const isAdmin = groups[code].adminId === socket.id;
    
    socket.emit('roleAssigned', { role: isAdmin ? 'admin' : 'worker', groupCode: code });
    socket.emit('syncGroup', groups[code].members);
    socket.emit('syncBaseline', groupBaselines[code]);
    
    console.log(`[USER JOINED] User ${socket.id} joined ${code}`);
  });

  // 3. LIVE AUTO-LAT/LON & ELEVATION SYNC
  socket.on('updateGroupData', (updatedMembersArray) => {
    if (currentGroup && groups[currentGroup]) {
      // Overwrite the server's array with the fresh GPS data
      groups[currentRoom].members = updatedMembersArray;
      
      // Broadcast the new coordinates and heights to everyone else for the Map
      socket.to(currentGroup).emit('syncGroup', groups[currentGroup].members);
    }
  });

  // 4. ADMIN REMOVES A PERSON
  socket.on('removePerson', (personId) => {
    if (currentGroup && groups[currentGroup]) {
      const group = groups[currentGroup];
      
      // Only Admin can remove others (or person removing themselves)
      if (group.adminId === socket.id) {
        group.members = group.members.filter(p => p.id !== personId);
        // Update everyone's map and roster
        io.to(currentGroup).emit('syncGroup', group.members);
      }
    }
  });

  // 5. SET BASELINE ELEVATION (ZERO POINT)
  socket.on('setBaseline', (newZeroPoint) => {
    if (currentGroup && typeof newZeroPoint === 'number') {
      groupBaselines[currentGroup] = newZeroPoint;
      io.to(currentGroup).emit('syncBaseline', newZeroPoint);
    }
  });

  // 6. EMERGENCY ALERTS
  socket.on('triggerFallAlert', (alertData) => {
    if (currentGroup) {
      socket.to(currentGroup).emit('receiveAlert', alertData);
    }
  });

  socket.on('triggerSOS', (payload) => {
    if (currentGroup) {
      io.to(currentGroup).emit('receiveSOS', payload);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[DISCONNECTED] User ${socket.id} left.`);
  });
});

// Start Server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`📡 Altiguard Server actively routing on port ${PORT}`);
});
