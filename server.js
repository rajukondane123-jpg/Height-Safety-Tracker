const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// Serves your index.html and style.css
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
    // 1. Broadcast the alert to all connected web dashboards
    if (currentRoom) socket.to(currentRoom).emit('receiveAlert', alertData);

    // 2. Check if a topic was actually provided from the UI
    const topic = alertData.ntfyTopic;
    
    if (!topic) {
        console.log("No ntfy topic provided. Skipping push notification.");
        return; // Exits safely if the input box was empty
    }
    
    // 3. Format the emergency message
    const workerInfo = alertData.phone ? `${alertData.name} (${alertData.phone})` : alertData.name;
    const message = `Worker ${workerInfo} dropped ${alertData.drop}m. Check status immediately.`;
    
    const headers = {
      'Title': 'URGENT: Altiguard Drop Detected!',
      'Priority': 'urgent',
      'Tags': 'rotating_light,warning,sos'
    };

    // Attach Google Maps link if GPS coordinates exist
    if (alertData.lat && alertData.lon) {
      headers['Click'] = `https://www.google.com/maps?q=${alertData.lat},${alertData.lon}`;
    }

    // 4. THE ULTIMATE FAILSAFE: Try fetch first, fallback to native https if Render fails
    if (typeof fetch !== 'undefined') {
      // Modern Node.js route (Node 18+)
      fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        body: message,
        headers: headers
      })
      .then(res => console.log(`Ntfy (fetch) sent with status: ${res.status}`))
      .catch(err => console.error("Ntfy (fetch) Error:", err));
    } else {
      // Bulletproof fallback route for older Render containers
      const https = require('https');
      const req = https.request(`https://ntfy.sh/${topic}`, { 
          method: 'POST', 
          headers: headers 
      }, (res) => {
          console.log(`Ntfy (https fallback) sent with status: ${res.statusCode}`);
      });
      
      req.on('error', (err) => console.error("Ntfy (https) Error:", err));
      req.write(message);
      req.end();
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
