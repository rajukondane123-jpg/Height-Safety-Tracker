const express = require('express');
const app = express();
const http = require('http').createServer(app);

// Extended timeouts for unstable field internet connections
const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000, 
  pingInterval: 25000
});

app.use(express.static(__dirname));
app.get('/ping', (req, res) => res.status(200).send('Altiguard Command API Active'));

const rooms = {}; 
const roomReferences = {};

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('createGroup', (roomCode) => {
    const code = (roomCode || "GRP-" + Math.random().toString(36).substring(2, 7)).toUpperCase().trim();
    if (currentRoom) socket.leave(currentRoom);
    
    currentRoom = code;
    socket.join(code);

    rooms[code] = { creatorSocketId: socket.id, members: [], zones: [], logs: [] };
    roomReferences[code] = 0;

    socket.emit('roleAssigned', { role: 'creator', roomCode: code });
    socket.emit('syncGroup', rooms[code].members);
    socket.emit('syncZones', rooms[code].zones);
    socket.emit('syncLogs', rooms[code].logs);
    socket.emit('syncReference', roomReferences[code]);
  });

  socket.on('joinGroup', (roomCode) => {
    const code = (roomCode || "").toUpperCase().trim();
    if (!rooms[code]) return socket.emit('groupError', 'Group does not exist.');

    if (currentRoom) socket.leave(currentRoom);
    currentRoom = code;
    socket.join(code);

    const isCreator = rooms[code].creatorSocketId === socket.id;
    socket.emit('roleAssigned', { role: isCreator ? 'creator' : 'worker', roomCode: code });
    socket.emit('syncGroup', rooms[code].members);
    socket.emit('syncZones', rooms[code].zones);
    socket.emit('syncLogs', rooms[code].logs);
    socket.emit('syncReference', roomReferences[code] || 0);
  });

  socket.on('logIncident', (msg) => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].logs.push({ time: new Date().toISOString(), msg });
      io.to(currentRoom).emit('syncLogs', rooms[currentRoom].logs);
    }
  });

  socket.on('triggerSOS', (payload) => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].logs.push({ time: new Date().toISOString(), msg: `🚨 SOS TRIGGERED by ${payload.name} at ${payload.height}m!` });
      io.to(currentRoom).emit('receiveSOS', payload);
      io.to(currentRoom).emit('syncLogs', rooms[currentRoom].logs);
    }
  });

  socket.on('addZone', (zone) => {
    if (currentRoom && rooms[currentRoom]) { 
      rooms[currentRoom].zones.push(zone); 
      io.to(currentRoom).emit('syncZones', rooms[currentRoom].zones); 
    }
  });

  socket.on('clearZones', () => {
    if (currentRoom && rooms[currentRoom]) { 
      rooms[currentRoom].zones = []; 
      io.to(currentRoom).emit('syncZones', rooms[currentRoom].zones); 
    }
  });

  socket.on('removeMember', ({ personId, requestedByPersonId, requesterRole }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.creatorSocketId === socket.id || requesterRole === 'sub-admin' || personId === requestedByPersonId) {
      room.members = room.members.filter(p => p.id !== personId);
      io.to(currentRoom).emit('syncGroup', room.members);
    } else socket.emit('groupError', 'Unauthorized action.');
  });

  socket.on('updateGroup', (newGroupData) => {
    if (currentRoom && rooms[currentRoom] && Array.isArray(newGroupData)) {
      rooms[currentRoom].members = newGroupData;
      socket.to(currentRoom).emit('syncGroup', rooms[currentRoom].members);
    }
  });

  socket.on('updateReference', (newRef) => {
    if (currentRoom && typeof newRef === 'number') {
      roomReferences[currentRoom] = newRef;
      io.to(currentRoom).emit('syncReference', newRef);
    }
  });

  socket.on('broadcastEmergencyLocation', (payload) => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].logs.push({ time: new Date().toISOString(), msg: `Emergency GPS Broadcast sent for ${payload.name}` });
      io.to(currentRoom).emit('receiveEmergencyBroadcast', payload);
    }
  });

  socket.on('triggerAlert', (alertData) => { 
    if (currentRoom) socket.to(currentRoom).emit('receiveAlert', alertData); 
  });

  // GEMINI AI INTEGRATION
  socket.on('requestAiInsight', async (siteData) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY; 
      if (!apiKey) return socket.emit('aiInsightResponse', { error: "Google API Key missing." });
      
      const prompt = `You are Altiguard AI, an expert structural safety assistant. Current Site Status: ${siteData.workerCount} personnel. Highest worker is at +${siteData.highestElevation}m. Local Weather: Wind ${siteData.windSpeed}, Temp ${siteData.temperature}. Danger Zones active: ${siteData.zonesCount}. Provide a brief, 2-sentence professional safety recommendation.`;
      
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) 
      });
      
      const data = await response.json();
      socket.emit('aiInsightResponse', { result: data.candidates[0].content.parts[0].text });
    } catch (err) { 
      socket.emit('aiInsightResponse', { error: "Failed to connect to Google AI Studio." }); 
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`[Altiguard] Server running on port ${PORT}`));
