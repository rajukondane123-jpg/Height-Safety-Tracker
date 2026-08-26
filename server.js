const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

// Keep-alive health check endpoint
app.get('/ping', (req, res) => res.status(200).send('Server active'));

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
      const message = `Worker ${workerInfo} dropped ${alertData.drop}m. Check status immediately.`;
      
      const headers = {
        'Title': 'URGENT: Altiguard Drop Detected!',
        'Priority': 'urgent',
        'Tags': 'rotating_light,warning,sos'
      };

      // Add clickable map link if coordinates are present
      if (alertData.lat && alertData.lon) {
        headers['Click'] = `https://www.google.com/maps?q=${alertData.lat},${alertData.lon}`;
      }

      fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        body: message,
        headers: headers
      })
      .then(res => console.log(`Ntfy sent with status: ${res.status}`))
      .catch(err => console.error("Ntfy Error:", err));
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
