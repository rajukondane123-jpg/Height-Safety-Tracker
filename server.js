/**
 * =========================================================
 * ALTIGUARD - SERVER.JS
 * =========================================================
 */
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const groups = {}; 
const groupBaselines = {}; 

io.on('connection', (socket) => {
  let currentGroup = null;

  socket.on('createGroup', (groupCode) => {
    const code = (groupCode || "TEAM123").toUpperCase().trim();
    if (currentGroup) socket.leave(currentGroup);
    
    currentGroup = code;
    socket.join(code);

    if (!groups[code]) groups[code] = { adminId: socket.id, members: [] };
    else if (groups[code].members.length === 0) groups[code].adminId = socket.id;
    
    if (groupBaselines[code] === undefined) groupBaselines[code] = 0;

    socket.emit('roleAssigned', { role: 'admin', groupCode: code });
    socket.emit('syncGroup', groups[code].members);
    socket.emit('syncBaseline', groupBaselines[code]);
  });

  socket.on('joinGroup', (groupCode) => {
    const code = (groupCode || "").toUpperCase().trim();
    if (!groups[code]) return socket.emit('groupError', 'Group code does not exist. Admin must create it first.');

    if (currentGroup) socket.leave(currentGroup);
    currentGroup = code;
    socket.join(code);

    const isAdmin = groups[code].adminId === socket.id;
    socket.emit('roleAssigned', { role: isAdmin ? 'admin' : 'worker', groupCode: code });
    socket.emit('syncGroup', groups[code].members);
    socket.emit('syncBaseline', groupBaselines[code]);
  });

  socket.on('updateGroupData', (updatedMembersArray) => {
    if (currentGroup && groups[currentGroup]) {
      groups[currentGroup].members = updatedMembersArray;
      socket.to(currentGroup).emit('syncGroup', groups[currentGroup].members);
    }
  });

  socket.on('removePerson', (personId) => {
    if (currentGroup && groups[currentGroup]) {
      groups[currentGroup].members = groups[currentGroup].members.filter(p => p.id !== personId);
      io.to(currentGroup).emit('syncGroup', groups[currentGroup].members);
    }
  });

  socket.on('setBaseline', (newZeroPoint) => {
    if (currentGroup && typeof newZeroPoint === 'number') {
      if (groups[currentGroup].adminId === socket.id) {
          groupBaselines[currentGroup] = newZeroPoint;
          io.to(currentGroup).emit('syncBaseline', newZeroPoint);
      } else {
          socket.emit('groupError', 'Access Denied: Only the Admin can set the Zero Point.');
      }
    }
  });

  socket.on('triggerFallAlert', (alertData) => { if (currentGroup) socket.to(currentGroup).emit('receiveAlert', alertData); });
  socket.on('triggerSOS', (payload) => { if (currentGroup) io.to(currentGroup).emit('receiveSOS', payload); });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`📡 Altiguard Server active on port ${PORT}`));
