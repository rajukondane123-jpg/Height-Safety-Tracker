const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// Serve your HTML, CSS, and JS files
app.use(express.static(__dirname));

// Store group data in server memory { 'GROUP1': [ {person1}, {person2} ] }
const rooms = {};

io.on('connection', (socket) => {
  let currentRoom = null;

  // Join a private group code
  socket.on('joinRoom', (roomCode) => {
    if (currentRoom) socket.leave(currentRoom);
    currentRoom = roomCode;
    socket.join(roomCode);
    
    // Create room if it doesn't exist, then send current data to the new user
    if (!rooms[roomCode]) rooms[roomCode] = [];
    socket.emit('syncGroup', rooms[roomCode]);
  });

  // When a phone updates a location/height, tell all other phones
  socket.on('updateGroup', (newGroupData) => {
    if (currentRoom) {
      rooms[currentRoom] = newGroupData;
      // Send to everyone else in the room
      socket.to(currentRoom).emit('syncGroup', rooms[currentRoom]);
    }
  });

  // Share sudden drop alerts to all phones
  socket.on('triggerAlert', (alertData) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('receiveAlert', alertData);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));

