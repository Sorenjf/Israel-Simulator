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

// Room storage: roomCode -> {
//   host: ws|null,
//   hostClientId,
//   hostDownTimer,
//   guests: Map<socketId, ws>,
//   guestClientIdToSocketId: Map<clientId, socketId>
// }
const rooms = new Map();
let nextId = 1;

// How long to keep a room alive after the host's WS drops, to allow reconnect.
const HOST_GRACE_MS = 90 * 1000;

wss.on('connection', (ws) => {
  ws.socketId = 'sock_' + (nextId++);
  ws.roomCode = null;
  ws.isHost = false;
  ws.isAlive = true;
  ws.clientId = null;

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
        rooms.set(code, {
          host: ws,
          hostClientId: data.clientId || null,
          hostDownTimer: null,
          guests: new Map(),
          guestClientIdToSocketId: new Map(),
        });
        ws.roomCode = code;
        ws.isHost = true;
        ws.clientId = data.clientId || null;
        ws.send(JSON.stringify({ type: 'roomCreated' }));
        break;
      }

      case 'resumeHost': {
        const code = data.roomCode;
        const room = rooms.get(code);
        if (!room || !room.hostClientId || room.hostClientId !== data.clientId) {
          ws.send(JSON.stringify({ type: 'resumeFailed', role: 'host' }));
          return;
        }
        if (room.hostDownTimer) { clearTimeout(room.hostDownTimer); room.hostDownTimer = null; }
        // Close previous host socket if still around
        if (room.host && room.host !== ws && room.host.readyState === 1) {
          try { room.host.close(); } catch {}
        }
        room.host = ws;
        ws.roomCode = code;
        ws.isHost = true;
        ws.clientId = data.clientId;
        ws.send(JSON.stringify({ type: 'resumedHost' }));
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
        ws.clientId = data.clientId || null;
        room.guests.set(ws.socketId, ws);
        if (ws.clientId) room.guestClientIdToSocketId.set(ws.clientId, ws.socketId);
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

      case 'resumeGuest': {
        const code = data.roomCode;
        const room = rooms.get(code);
        if (!room || !room.host || room.host.readyState !== 1 || !data.clientId) {
          ws.send(JSON.stringify({ type: 'resumeFailed', role: 'guest' }));
          return;
        }
        const oldSocketId = room.guestClientIdToSocketId.get(data.clientId);
        if (!oldSocketId) {
          ws.send(JSON.stringify({ type: 'resumeFailed', role: 'guest' }));
          return;
        }
        // Close any stale ws under that socketId
        const prev = room.guests.get(oldSocketId);
        if (prev && prev !== ws && prev.readyState === 1) {
          try { prev.close(); } catch {}
        }
        // Reuse the old socketId so the host's playerIdx map keeps working
        ws.socketId = oldSocketId;
        ws.roomCode = code;
        ws.isHost = false;
        ws.clientId = data.clientId;
        room.guests.set(oldSocketId, ws);
        ws.send(JSON.stringify({ type: 'resumedGuest' }));
        // Ask host to resend state to this guest
        if (room.host && room.host.readyState === 1) {
          room.host.send(JSON.stringify({ type: 'guestResumed', socketId: oldSocketId }));
        }
        break;
      }

      default: {
        // Generic message routing
        const room = rooms.get(ws.roomCode);
        if (!room) return;

        if (ws.isHost) {
          // Host -> guests
          if (data._targetSocketId) {
            const targetId = data._targetSocketId;
            delete data._targetSocketId;
            const target = room.guests.get(targetId);
            if (target && target.readyState === 1) {
              target.send(JSON.stringify(data));
            }
          } else if (data._excludeSocketId) {
            const excludeId = data._excludeSocketId;
            delete data._excludeSocketId;
            const msg = JSON.stringify(data);
            room.guests.forEach((g, id) => {
              if (id !== excludeId && g.readyState === 1) g.send(msg);
            });
          } else {
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
      // Only tear down if this ws is still the current host (might have been replaced by resume)
      if (room.host !== ws) return;
      // Grace period for host to reconnect
      room.host = null;
      if (room.hostDownTimer) clearTimeout(room.hostDownTimer);
      room.hostDownTimer = setTimeout(() => {
        const r = rooms.get(ws.roomCode);
        if (!r) return;
        if (r.host && r.host.readyState === 1) return; // host came back
        r.guests.forEach((g) => {
          try { g.send(JSON.stringify({ type: 'hostDisconnected' })); } catch {}
        });
        rooms.delete(ws.roomCode);
      }, HOST_GRACE_MS);
    } else {
      // Only remove if the current entry for this socketId is this ws
      const current = room.guests.get(ws.socketId);
      if (current !== ws) return;
      room.guests.delete(ws.socketId);
      if (ws.clientId) room.guestClientIdToSocketId.delete(ws.clientId);
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
    try { ws.ping(); } catch {}
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Israel Simulator running at http://localhost:${PORT}`);
});
