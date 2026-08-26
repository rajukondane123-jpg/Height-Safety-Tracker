  socket.on('triggerAlert', (alertData) => {
    if (currentRoom) socket.to(currentRoom).emit('receiveAlert', alertData);

    const topic = alertData.ntfyTopic; 
    
    if (topic) {
      const workerInfo = alertData.phone ? `${alertData.name} (${alertData.phone})` : alertData.name;
      const message = `Worker ${workerInfo} just dropped ${alertData.drop}m. Please check their status immediately.`;
      
      const messageBuffer = Buffer.from(message, 'utf8');

      const options = {
        hostname: 'ntfy.sh',
        port: 443,
        path: `/${topic}`,
        method: 'POST',
        headers: {
          'Title': 'URGENT: Altiguard Drop Detected!', // <-- EMOJI REMOVED HERE
          'Priority': 'urgent',
          'Tags': 'rotating_light,warning,sos',
          'Content-Type': 'text/plain',
          'Content-Length': messageBuffer.length 
        }
      };

      const req = https.request(options, (res) => {
        console.log(`Ntfy sent with status: ${res.statusCode}`);
        res.on('data', (d) => {
          console.log(`Ntfy response: ${d}`);
        });
      });

      req.on('error', (e) => {
        console.error(`Ntfy Error: ${e.message}`);
      });

      req.write(messageBuffer);
      req.end();
    }
  });
