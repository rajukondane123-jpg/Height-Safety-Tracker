const express = require('express');
const app = express();
const http = require('http').createServer(app);

// Configured with extended timeouts for unstable mobile field connections
const io = require('socket.io')(http, {
  cors: { origin: "*" },
  pingTimeout: 60000, 
  pingInterval: 25000
});

app.use(express.static(__dirname));

app.get('/ping', (req, res) => res.status(200).send('Server active'));

const rooms = {};
const roomReferences = {};

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('joinRoom', (roomCode) => {
    if (typeof roomCode !== 'string' || !roomCode.trim()) return;
    const code = roomCode.trim();

    if (currentRoom) socket.leave(currentRoom);
    currentRoom = code;
    socket.join(code);
    
    if (!rooms[code]) rooms[code] = [];
    if (roomReferences[code] === undefined) roomReferences[code] = 0;
    
    socket.emit('syncGroup', rooms[code]);
    socket.emit('syncReference', roomReferences[code]);
  });

  socket.on('updateGroup', (newGroupData) => {
    if (currentRoom && Array.isArray(newGroupData)) {
      rooms[currentRoom] = newGroupData;
      socket.to(currentRoom).emit('syncGroup', rooms[currentRoom]);
    }
  });

  socket.on('updateReference', (newRef) => {
    if (currentRoom && typeof newRef === 'number') {
      roomReferences[currentRoom] = newRef;
      io.to(currentRoom).emit('syncReference', newRef);
    }
  });

  socket.on('triggerAlert', (alertData) => {
    // Purely broadcasts to the other dashboards on the site
    if (currentRoom) socket.to(currentRoom).emit('receiveAlert', alertData);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`[Altiguard] Server running on port ${PORT}`));
