const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const twilio = require('twilio');

const twilioClient = process.env.TWILIO_ACCOUNT_SID 
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) 
  : null;

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

    const targetManagerPhone = alertData.managerPhone || process.env.MANAGER_PHONE;

    if (twilioClient && targetManagerPhone && !alertData.test) {
      const workerInfo = alertData.phone ? `${alertData.name} (${alertData.phone})` : alertData.name;
      
      twilioClient.messages.create({
        body: `⚠️ URGENT [Altiguard]: Sudden drop detected! Worker ${workerInfo} dropped ${alertData.drop}m.`,
        from: process.env.TWILIO_PHONE,
        to: targetManagerPhone
      }).catch(err => console.error("Twilio SMS Error:", err));
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
