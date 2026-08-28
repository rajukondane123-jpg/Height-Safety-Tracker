/**
 * =========================================================
 * ALTIGUARD KERNEL - BACKEND SERVER (SERVER.JS)
 * =========================================================
 */
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const https = require('https'); // Native module to prevent fetch crashes

app.use(express.static(__dirname));
app.use(express.json());

const groups = {}; 
const groupBaselines = {}; 
const groupNtfyTopics = {};
const groupGeofenceRadius = {};

// Bulletproof Server-Side Ntfy Push (Bypasses Browser Adblockers)
function sendNtfyServerSide(topic, title, message, tags, clickUrl) {
  if (!topic) return;
  const cleanTopic = topic.replace(/[^a-zA-Z0-9-_]/g, "");
  
  let path = `/${cleanTopic}?title=${encodeURIComponent(title)}&priority=urgent&tags=${encodeURIComponent(tags)}`;
  if (clickUrl) path += `&click=${encodeURIComponent(clickUrl)}`;

  const req = https.request({ hostname: 'ntfy.sh', path: path, method: 'POST' }, (res) => {
    console.log(`[NTFY DISPATCH] Sent to ${cleanTopic} | Status: ${res.statusCode}`);
  });
  req.on('error', (e) => console.error(`[NTFY ERR] ${e.message}`));
  req.write(message);
  req.end();
}

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
    if (groupGeofenceRadius[code] === undefined) groupGeofenceRadius[code] = 500;

    socket.emit('roleAssigned', { role: 'admin', groupCode: code });
    socket.emit('syncGroup', groups[code].members);
    socket.emit('syncBaseline', groupBaselines[code]);
    socket.emit('syncGeofence', groupGeofenceRadius[code]);
    socket.emit('syncNtfyTopic', groupNtfyTopics[code] || "");
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
    socket.emit('syncBaseline', groupBaselines[code] || 0);
    socket.emit('syncGeofence', groupGeofenceRadius[code] || 500);
    socket.emit('syncNtfyTopic', groupNtfyTopics[code] || "");
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
    if (currentGroup && typeof newZeroPoint === 'number' && groups[currentGroup].adminId === socket.id) {
        groupBaselines[currentGroup] = newZeroPoint;
        io.to(currentGroup).emit('syncBaseline', newZeroPoint);
    }
  });

  socket.on('updateGeofenceRadius', (radius) => {
    if (currentGroup && typeof radius === 'number' && groups[currentGroup].adminId === socket.id) {
        groupGeofenceRadius[currentGroup] = radius;
        io.to(currentGroup).emit('syncGeofence', radius);
    }
  });

  socket.on('updateNtfyTopic', (topic) => {
    if (currentGroup && typeof topic === 'string' && groups[currentGroup].adminId === socket.id) {
        groupNtfyTopics[currentGroup] = topic;
        io.to(currentGroup).emit('syncNtfyTopic', topic);
    }
  });

  socket.on('triggerFallAlert', (alertData) => { 
    if (currentGroup) {
      socket.to(currentGroup).emit('receiveAlert', alertData);
      sendNtfyServerSide(groupNtfyTopics[currentGroup], `🚨 FALL ALERT: ${alertData.name}`, `${alertData.name} dropped ${alertData.drop}m!`, "rotating_light,skull", alertData.lat ? `https://www.google.com/maps?q=${alertData.lat},${alertData.lon}` : null);
    }
  });

  socket.on('triggerSOS', (payload) => { 
    if (currentGroup) {
      io.to(currentGroup).emit('receiveSOS', payload);
      sendNtfyServerSide(groupNtfyTopics[currentGroup], `🚨 SOS: ${payload.name}`, `${payload.name} triggered SOS panic protocol!`, "sos,rotating_light", payload.lat ? `https://www.google.com/maps?q=${payload.lat},${payload.lon}` : null);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`🚀 Altiguard Tactical Core online on port ${PORT}`));
