const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

const rooms = {};
const roomReferences = {}; // Stores the fixed ground level (0m) for each room

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('joinRoom', (roomCode) => {
    if (currentRoom) socket.leave(currentRoom);
    currentRoom = roomCode;
    socket.join(roomCode);
    
    if (!rooms[roomCode]) rooms[roomCode] = [];
    if (roomReferences[roomCode] === undefined) roomReferences[roomCode] = 0; // Default to 0
    
    socket.emit('syncGroup', rooms[roomCode]);
    socket.emit('syncReference', roomReferences[roomCode]); // Send zero level to new user
  });

  socket.on('updateGroup', (newGroupData) => {
    if (currentRoom) {
      rooms[currentRoom] = newGroupData;
      socket.to(currentRoom).emit('syncGroup', rooms[currentRoom]);
    }
  });

  // When Admin updates the fixed ground level
  socket.on('updateReference', (newRef) => {
    if (currentRoom) {
      roomReferences[currentRoom] = newRef;
      io.to(currentRoom).emit('syncReference', newRef); // Update everyone instantly
    }
  });

  socket.on('triggerAlert', (alertData) => {
    if (currentRoom) socket.to(currentRoom).emit('receiveAlert', alertData);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
