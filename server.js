const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

const rooms = {};
const roomReferences = {};

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('joinRoom', (roomCode) => {
    if (currentRoom) socket.leave(currentRoom);
    currentRoom = roomCode;
    socket.join(roomCode);
    
    if (!rooms[roomCode]) rooms[roomCode] = [];
    if (roomReferences[roomCode] === undefined) roomReferences[roomCode] = 0;
    
    socket.emit('syncGroup', rooms[roomCode]);
    socket.emit('syncReference', roomReferences[roomCode]);
  });

  socket.on('updateGroup', (newGroupData) => {
    if (currentRoom) {
      rooms[currentRoom] = newGroupData;
      socket.to(currentRoom).emit('syncGroup', rooms[currentRoom]);
    }
  });

  socket.on('updateReference', (newRef) => {
    if (currentRoom) {
      roomReferences[currentRoom] = newRef;
      io.to(currentRoom).emit('syncReference', newRef);
    }
  });

  socket.on('triggerAlert', (alertData) => {
    // 1. Broadcast alert to all clients in the room
    if (currentRoom) socket.to(currentRoom).emit('receiveAlert', alertData);

    // 2. Anonymous Ntfy.sh Push Notification
    const topic = alertData.ntfyTopic; // The secret topic entered in the UI
    
    if (topic) {
      const workerInfo = alertData.phone ? `${alertData.name} (${alertData.phone})` : alertData.name;
      const message = `Worker ${workerInfo} just dropped ${alertData.drop}m. Please check their status immediately.`;
      
      // Native Node fetch request to ntfy.sh (No API keys or accounts needed!)
      fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        body: message,
        headers: {
            'Title': '⚠️ URGENT: Altiguard Drop Detected!',
            'Priority': 'urgent',
            'Tags': 'rotating_light,warning,sos'
        }
      }).catch(err => console.error("Ntfy Error:", err));
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
