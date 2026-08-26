const express = require('express');
const https = require('https'); // <-- Added native https module
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
    if (currentRoom) socket.to(currentRoom).emit('receiveAlert', alertData);

    const topic = alertData.ntfyTopic; 
    
    if (topic) {
      const workerInfo = alertData.phone ? `${alertData.name} (${alertData.phone})` : alertData.name;
      const message = `Worker ${workerInfo} just dropped ${alertData.drop}m. Please check their status immediately.`;
      
      // Using bulletproof native HTTPS instead of fetch
      const options = {
        hostname: 'ntfy.sh',
        port: 443,
        path: `/${topic}`,
        method: 'POST',
        headers: {
          'Title': '⚠️ URGENT: Altiguard Drop Detected!',
          'Priority': 'urgent',
          'Tags': 'rotating_light,warning,sos'
        }
      };

      const req = https.request(options, (res) => {
        console.log(`Ntfy sent with status: ${res.statusCode}`);
      });

      req.on('error', (e) => {
        console.error(`Ntfy Error: ${e.message}`);
      });

      req.write(message);
      req.end();
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
