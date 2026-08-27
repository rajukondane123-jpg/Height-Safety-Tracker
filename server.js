const express = require('express');
const app = express();
const http = require('http').createServer(app);

// UPGRADE: Configured for unstable mobile connections in the field
const io = require('socket.io')(http, {
  cors: { origin: "*" },
  pingTimeout: 60000, 
  pingInterval: 25000
});
const https = require('https');

app.use(express.static(__dirname));

// Keep-alive endpoint
app.get('/ping', (req, res) => res.status(200).send('Server active'));

const rooms = {};
const roomReferences = {};

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('joinRoom', (roomCode) => {
    // UPGRADE: Strict type-checking to prevent crashes from bad inputs
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
    // UPGRADE: Ensure incoming group data is actually an array before saving
    if (currentRoom && Array.isArray(newGroupData)) {
      rooms[currentRoom] = newGroupData;
      socket.to(currentRoom).emit('syncGroup', rooms[currentRoom]);
    }
  });

  socket.on('updateReference', (newRef) => {
    // UPGRADE: Ensure the reference level is a valid number
    if (currentRoom && typeof newRef === 'number') {
      roomReferences[currentRoom] = newRef;
      io.to(currentRoom).emit('syncReference', newRef);
    }
  });

  socket.on('triggerAlert', (alertData) => {
    if (!alertData || typeof alertData !== 'object') return;
    
    // Broadcast alert to all clients in the room
    if (currentRoom) socket.to(currentRoom).emit('receiveAlert', alertData);

    const topic = alertData.ntfyTopic;
    if (!topic || typeof topic !== 'string') {
      console.log(`[${new Date().toISOString()}] Ntfy Error: No valid topic specified.`);
      return;
    }

    const workerInfo = alertData.phone ? `${alertData.name} (${alertData.phone})` : (alertData.name || "Unknown Worker");
    const dropAmount = alertData.drop !== undefined ? alertData.drop : "unknown";
    const message = `Worker ${workerInfo} dropped ${dropAmount}m. Check status immediately.`;

    const options = {
      hostname: 'ntfy.sh',
      port: 443,
      path: `/${encodeURIComponent(topic.trim())}`,
      method: 'POST',
      headers: {
        'Title': 'URGENT: Altiguard Drop Detected!',
        'Priority': 'urgent',
        'Tags': 'rotating_light,warning,sos',
        'Content-Type': 'text/plain'
      },
      timeout: 5000 // UPGRADE: 5-second timeout prevents the server from hanging if blocked
    };

    if (alertData.lat && alertData.lon) {
      options.headers['Click'] = `https://www.google.com/maps?q=${alertData.lat},${alertData.lon}`;
    }

    const req = https.request(options, (res) => {
      console.log(`[${new Date().toISOString()}] Emergency Dispatch Sent. Status code: ${res.statusCode}`);
    });

    // UPGRADE: Handle firewall blocks gracefully
    req.on('timeout', () => {
      console.error(`[${new Date().toISOString()}] Ntfy Dispatch Timeout. Connection killed to prevent memory leak.`);
      req.destroy(); 
    });

    req.on('error', (error) => {
      console.error(`[${new Date().toISOString()}] Ntfy Dispatch Error:`, error.message);
    });

    req.write(message);
    req.end();
  });
  
  socket.on('disconnect', () => {
      // Future-proofing: Logs when a device drops connection
      // console.log(`[${new Date().toISOString()}] Device disconnected from ${currentRoom || 'lobby'}`);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`[Altiguard] Structural Safety Server running on port ${PORT}`));
