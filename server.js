const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');

// ── Database Setup ──
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    display_name TEXT NOT NULL,
    preferred_color TEXT DEFAULT '',
    profile_picture TEXT DEFAULT '',
    email TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Migrations for existing DBs
try { db.exec("ALTER TABLE users ADD COLUMN profile_picture TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''"); } catch {}

// Prepared statements
const stmts = {
  findUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (username, password_hash, salt, display_name) VALUES (?, ?, ?, ?)'),
  insertSession: db.prepare("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"),
  findSession: db.prepare("SELECT s.*, u.username, u.display_name, u.preferred_color, u.profile_picture, u.email FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')"),
  updateProfile: db.prepare('UPDATE users SET display_name = ?, preferred_color = ?, email = ? WHERE id = ?'),
  updateProfilePicture: db.prepare('UPDATE users SET profile_picture = ? WHERE id = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
};

// ── Auth Helpers ──
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve(null); }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getUserFromToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  return stmts.findSession.get(token) || null;
}

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  // CORS headers for API
  if (req.url.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  }

  // ── API Routes ──
  if (req.method === 'POST' && req.url === '/api/register') {
    const body = await readBody(req);
    if (!body || !body.username || !body.password) {
      return jsonResponse(res, 400, { error: 'Username and password are required' });
    }
    const username = body.username.trim().toLowerCase();
    const displayName = body.displayName || body.username.trim();
    if (username.length < 3 || username.length > 20) {
      return jsonResponse(res, 400, { error: 'Username must be 3-20 characters' });
    }
    if (!/^[a-z0-9_]+$/.test(username)) {
      return jsonResponse(res, 400, { error: 'Username can only contain letters, numbers, and underscores' });
    }
    if (body.password.length < 4) {
      return jsonResponse(res, 400, { error: 'Password must be at least 4 characters' });
    }
    const existing = stmts.findUserByUsername.get(username);
    if (existing) {
      return jsonResponse(res, 409, { error: 'Username already taken' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(body.password, salt);
    const result = stmts.insertUser.run(username, hash, salt, displayName);
    const token = generateToken();
    stmts.insertSession.run(result.lastInsertRowid, token);
    return jsonResponse(res, 201, { token, username, displayName, preferredColor: '', profilePicture: '', email: '' });
  }

  if (req.method === 'POST' && req.url === '/api/login') {
    const body = await readBody(req);
    if (!body || !body.username || !body.password) {
      return jsonResponse(res, 400, { error: 'Username and password are required' });
    }
    const username = body.username.trim().toLowerCase();
    const user = stmts.findUserByUsername.get(username);
    if (!user) {
      return jsonResponse(res, 401, { error: 'Invalid username or password' });
    }
    const hash = hashPassword(body.password, user.salt);
    if (hash !== user.password_hash) {
      return jsonResponse(res, 401, { error: 'Invalid username or password' });
    }
    const token = generateToken();
    stmts.insertSession.run(user.id, token);
    return jsonResponse(res, 200, { token, username: user.username, displayName: user.display_name, preferredColor: user.preferred_color, profilePicture: user.profile_picture || '', email: user.email || '' });
  }

  if (req.method === 'GET' && req.url === '/api/me') {
    const session = getUserFromToken(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'Not authenticated' });
    }
    return jsonResponse(res, 200, { username: session.username, displayName: session.display_name, preferredColor: session.preferred_color, profilePicture: session.profile_picture || '', email: session.email || '' });
  }

  if (req.method === 'POST' && req.url === '/api/update-profile') {
    const session = getUserFromToken(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'Not authenticated' });
    }
    const body = await readBody(req);
    if (!body) return jsonResponse(res, 400, { error: 'Invalid request' });
    const displayName = (body.displayName || session.display_name).trim().slice(0, 16);
    const preferredColor = body.preferredColor || session.preferred_color || '';
    const email = body.email !== undefined ? body.email.trim().slice(0, 100) : (session.email || '');
    stmts.updateProfile.run(displayName, preferredColor, email, session.user_id);
    return jsonResponse(res, 200, { displayName, preferredColor, email });
  }

  if (req.method === 'POST' && req.url === '/api/upload-picture') {
    const session = getUserFromToken(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'Not authenticated' });
    }
    const body = await readBody(req);
    if (!body || !body.picture) return jsonResponse(res, 400, { error: 'No picture provided' });
    // Validate it's a data URI and not too large (max ~500KB base64)
    if (!body.picture.startsWith('data:image/') || body.picture.length > 700000) {
      return jsonResponse(res, 400, { error: 'Invalid image or too large (max 500KB)' });
    }
    stmts.updateProfilePicture.run(body.picture, session.user_id);
    return jsonResponse(res, 200, { profilePicture: body.picture });
  }

  if (req.method === 'POST' && req.url === '/api/logout') {
    const session = getUserFromToken(req);
    if (session) stmts.deleteSession.run(session.token);
    return jsonResponse(res, 200, { ok: true });
  }

  // ── Static Files ──
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

// ── WebSocket Server ──
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
        room.host.send(JSON.stringify({
          type: 'join',
          name: data.name,
          emoji: data.emoji,
          profilePicture: data.profilePicture || '',
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
        const prev = room.guests.get(oldSocketId);
        if (prev && prev !== ws && prev.readyState === 1) {
          try { prev.close(); } catch {}
        }
        ws.socketId = oldSocketId;
        ws.roomCode = code;
        ws.isHost = false;
        ws.clientId = data.clientId;
        room.guests.set(oldSocketId, ws);
        ws.send(JSON.stringify({ type: 'resumedGuest' }));
        if (room.host && room.host.readyState === 1) {
          room.host.send(JSON.stringify({ type: 'guestResumed', socketId: oldSocketId }));
        }
        break;
      }

      default: {
        const room = rooms.get(ws.roomCode);
        if (!room) return;

        if (ws.isHost) {
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
      if (room.host !== ws) return;
      room.host = null;
      if (room.hostDownTimer) clearTimeout(room.hostDownTimer);
      room.hostDownTimer = setTimeout(() => {
        const r = rooms.get(ws.roomCode);
        if (!r) return;
        if (r.host && r.host.readyState === 1) return;
        r.guests.forEach((g) => {
          try { g.send(JSON.stringify({ type: 'hostDisconnected' })); } catch {}
        });
        rooms.delete(ws.roomCode);
      }, HOST_GRACE_MS);
    } else {
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
