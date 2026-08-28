/**
 * =========================================================
 * ALTIGUARD - SERVER.JS
 * =========================================================
 * Fixed connection routing and strict Admin Authority checks.
 */

const express = require('express');
const app = express();
const http = require('http').createServer(app);

const io = require('socket.io')(http, {
  cors: { origin: "*" }
});

app.use(express.static(__dirname));

const groups = {}; 
const groupBaselines = {}; 

io.on('connection', (socket) => {
  let currentGroup = null;

  // 1. ADMIN CREATES GROUP
  socket.on('createGroup', (groupCode) => {
    const code = (groupCode || "TEAM123").toUpperCase().trim();
    
    // Fixed crash bug: leave currentGroup, not currentRoom
    if (currentGroup) socket.leave(currentGroup);
    
    currentGroup = code;
    socket.join(code);

    if (!groups[code]) {
      groups[code] = {
        adminId: socket.id,
        members: []
      };
    } else if (groups[code].members.length === 0) {
      // Reclaim admin rights if the group is empty
      groups[code].adminId = socket.id;
    }
    
    if (groupBaselines[code] === undefined) groupBaselines[code] = 0;

    socket.emit('roleAssigned', { role: 'admin', groupCode: code });
    socket.emit('syncGroup', groups[code].members);
    socket.emit('syncBaseline', groupBaselines[code]);
    
    console.log(`[GROUP CREATED] ${code} by Admin ${socket.id}`);
  });

  // 2. WORKER JOINS GROUP
  socket.on('joinGroup', (groupCode) => {
    const code = (groupCode || "").toUpperCase().trim();
    
    if (!groups[code]) {
      socket.emit('groupError', 'This group code does not exist. Admin must create it first.');
      return;
    }

    if (currentGroup) socket.leave(currentGroup);
    currentGroup = code;
    socket.join(code);

    const isAdmin = groups[code].adminId === socket.id;
    
    socket.emit('roleAssigned', { role: isAdmin ? 'admin' : 'worker', groupCode: code });
    socket.emit('syncGroup', groups[code].members);
    socket.emit('syncBaseline', groupBaselines[code]);
    
    console.log(`[USER JOINED] User ${socket.id} joined ${code}`);
  });

  // 3. SYNC TELEMETRY
  socket.on('updateGroupData', (updatedMembersArray) => {
    if (currentGroup && groups[currentGroup]) {
      groups[currentGroup].members = updatedMembersArray;
      socket.to(currentGroup).emit('syncGroup', groups[currentGroup].members);
    }
  });

  // 4. REMOVE PERSON (Admin or Self)
  socket.on('removePerson', (personId) => {
    if (currentGroup && groups[currentGroup]) {
      const group = groups[currentGroup];
      group.members = group.members.filter(p => p.id !== personId);
      io.to(currentGroup).emit('syncGroup', group.members);
    }
  });

  // 5. SET ZERO POINT (Backend Admin Lock)
  socket.on('setBaseline', (newZeroPoint) => {
    if (currentGroup && typeof newZeroPoint === 'number') {
      // Strictly enforce that only the Admin can set the baseline
      if (groups[currentGroup].adminId === socket.id) {
          groupBaselines[currentGroup] = newZeroPoint;
          io.to(currentGroup).emit('syncBaseline', newZeroPoint);
      } else {
          socket.emit('groupError', 'Access Denied: Only the Admin can calibrate the Zero Point.');
      }
    }
  });

  // 6. ALERTS
  socket.on('triggerFallAlert', (alertData) => {
    if (currentGroup) socket.to(currentGroup).emit('receiveAlert', alertData);
  });

  socket.on('triggerSOS', (payload) => {
    if (currentGroup) io.to(currentGroup).emit('receiveSOS', payload);
  });

  socket.on('disconnect', () => {
    console.log(`[DISCONNECTED] User ${socket.id} left.`);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`📡 Altiguard Server actively routing on port ${PORT}`);
});
