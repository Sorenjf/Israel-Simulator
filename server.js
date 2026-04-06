const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// Serve the HTML file
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'israel-simulator.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else if (req.url === '/images.js') {
    fs.readFile(path.join(__dirname, 'images.js'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

// Room storage: roomCode -> { host: ws, guests: Map<socketId, ws> }
const rooms = new Map();
let nextId = 1;

wss.on('connection', (ws) => {
  ws.socketId = 'sock_' + (nextId++);
  ws.roomCode = null;
  ws.isHost = false;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    switch (data.type) {
      case 'createRoom': {
        const code = data.roomCode;
        if (rooms.has(code)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room code already exists, try again' }));
          return;
        }
        rooms.set(code, { host: ws, guests: new Map() });
        ws.roomCode = code;
        ws.isHost = true;
        ws.send(JSON.stringify({ type: 'roomCreated' }));
        break;
      }

      case 'joinRoom': {
        const code = data.roomCode;
        const room = rooms.get(code);
        if (!room || !room.host || room.host.readyState !== 1) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        ws.roomCode = code;
        ws.isHost = false;
        room.guests.set(ws.socketId, ws);
        // Forward join to host with guest's socketId
        room.host.send(JSON.stringify({
          type: 'join',
          name: data.name,
          emoji: data.emoji,
          socketId: ws.socketId
        }));
        ws.send(JSON.stringify({ type: 'joined' }));
        break;
      }

      default: {
        // Generic message routing
        const room = rooms.get(ws.roomCode);
        if (!room) return;

        if (ws.isHost) {
          // Host -> guests
          if (data._targetSocketId) {
            // Directed message to one guest
            const targetId = data._targetSocketId;
            delete data._targetSocketId;
            const target = room.guests.get(targetId);
            if (target && target.readyState === 1) {
              target.send(JSON.stringify(data));
            }
          } else if (data._excludeSocketId) {
            // Broadcast to all except one
            const excludeId = data._excludeSocketId;
            delete data._excludeSocketId;
            const msg = JSON.stringify(data);
            room.guests.forEach((g, id) => {
              if (id !== excludeId && g.readyState === 1) g.send(msg);
            });
          } else {
            // Broadcast to all guests
            const msg = JSON.stringify(data);
            room.guests.forEach((g) => {
              if (g.readyState === 1) g.send(msg);
            });
          }
        } else {
          // Guest -> host: attach sender's socketId
          data._senderSocketId = ws.socketId;
          if (room.host && room.host.readyState === 1) {
            room.host.send(JSON.stringify(data));
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (ws.isHost) {
      // Host left — notify all guests, tear down room
      room.guests.forEach((g) => {
        try { g.send(JSON.stringify({ type: 'hostDisconnected' })); } catch {}
      });
      rooms.delete(ws.roomCode);
    } else {
      room.guests.delete(ws.socketId);
      // Notify host that guest disconnected
      if (room.host && room.host.readyState === 1) {
        room.host.send(JSON.stringify({ type: 'guestDisconnected', socketId: ws.socketId }));
      }
    }
  });
});

// Heartbeat to detect stale connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Israel Simulator running at http://localhost:${PORT}`);
  console.log(`Share this address with friends on the same network,`);
  console.log(`or deploy to a hosting service for internet play.`);
});
