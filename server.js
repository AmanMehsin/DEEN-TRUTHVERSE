const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'community.json');
const MAX_BODY = 16_000;
const sessions = new Map();
const callRoom = new Map();
const callSignals = new Map();

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
let db = fs.existsSync(DB_PATH)
  ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
  : { users: [], messages: [], banned: [] };
db.users ||= [];
db.messages ||= [];
db.banned ||= [];
function persist() {
  const temp = DB_PATH + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DB_PATH);
}
function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function safeUser(user) { return { name: user.name, email: user.email, role: user.role, joinedAt: user.joinedAt }; }
function getUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const email = sessions.get(token);
  return email ? db.users.find(user => user.email === email) : null;
}
function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, user.email);
  return token;
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve({ salt, hash: key.toString('hex') })));
}
function verifyPassword(password, user) {
  return new Promise((resolve, reject) => crypto.scrypt(password, user.salt, 64, (error, key) => {
    if (error) return reject(error);
    resolve(crypto.timingSafeEqual(key, Buffer.from(user.passwordHash, 'hex')));
  }));
}
function communityPayload(viewer) {
  return {
    members: db.users.map(safeUser),
    messages: db.messages.slice(-150).map(({ email, ...message }) => ({ ...message, mine: email === viewer.email })),
    onlineCount: sessions.size
  };
}
function cleanCallRoom() {
  const expired = Date.now() - 15_000;
  for (const [id, participant] of callRoom) {
    if (participant.lastSeen < expired) {
      callRoom.delete(id);
      callSignals.delete(id);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return reply(res, 200, { ok: true });

    if (req.method === 'POST' && ['/api/signup', '/api/login'].includes(url.pathname)) {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim().slice(0, 24);
      const password = String(body.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(res, 400, { error: 'Enter a valid email address.' });
      if (password.length < 10 || password.length > 200) return reply(res, 400, { error: 'Use a password with at least 10 characters.' });
      let user = db.users.find(item => item.email === email);
      if (url.pathname === '/api/signup') {
        if (!name) return reply(res, 400, { error: 'Enter your name.' });
        if (db.banned.includes(email)) return reply(res, 403, { error: 'This email was removed from the community.' });
        if (user) return reply(res, 409, { error: 'An account with that email already exists. Sign in instead.' });
        const credentials = await hashPassword(password);
        user = { name, email, ...credentials, role: db.users.length === 0 ? 'leader' : 'member', joinedAt: new Date().toISOString() };
        db.users.push(user);
        persist();
      } else {
        if (!user || !(await verifyPassword(password, user))) return reply(res, 401, { error: 'Email or password is incorrect.' });
      }
      const token = createSession(user);
      return reply(res, 200, { token, user: safeUser(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      sessions.delete(token);
      return reply(res, 200, { ok: true });
    }

    if (url.pathname.startsWith('/api/')) {
      const user = getUser(req);
      if (!user) return reply(res, 401, { error: 'Please sign in again.' });
      if (req.method === 'GET' && url.pathname === '/api/me') return reply(res, 200, { user: safeUser(user) });
      if (req.method === 'GET' && url.pathname === '/api/community') return reply(res, 200, communityPayload(user));
      if (req.method === 'GET' && url.pathname === '/api/call/config') {
        const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
        if (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
          iceServers.push({ urls: process.env.TURN_URLS.split(',').map(value => value.trim()).filter(Boolean), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
        }
        return reply(res, 200, { iceServers });
      }
      if (req.method === 'POST' && url.pathname === '/api/call/join') {
        const body = await readBody(req);
        const clientId = String(body.clientId || '');
        if (!/^[a-f0-9-]{36}$/i.test(clientId)) return reply(res, 400, { error: 'Invalid call session.' });
        cleanCallRoom();
        const peers = [...callRoom.entries()].filter(([id, p]) => id !== clientId && p.email !== user.email).map(([id, p]) => ({ clientId: id, name: p.name }));
        callRoom.set(clientId, { email: user.email, name: user.name, lastSeen: Date.now() });
        callSignals.set(clientId, []);
        return reply(res, 200, { peers });
      }
      if (req.method === 'GET' && url.pathname === '/api/call/state') {
        const clientId = String(url.searchParams.get('clientId') || '');
        const current = callRoom.get(clientId);
        if (!current || current.email !== user.email) return reply(res, 404, { error: 'You are no longer in the voice lounge.' });
        cleanCallRoom();
        current.lastSeen = Date.now();
        const peers = [...callRoom.entries()].filter(([id, p]) => id !== clientId && p.email !== user.email).map(([id, p]) => ({ clientId: id, name: p.name }));
        const signals = callSignals.get(clientId) || [];
        callSignals.set(clientId, []);
        return reply(res, 200, { peers, signals });
      }
      if (req.method === 'POST' && url.pathname === '/api/call/signal') {
        const body = await readBody(req);
        const fromClientId = String(body.fromClientId || ''), toClientId = String(body.toClientId || '');
        const sender = callRoom.get(fromClientId), receiver = callRoom.get(toClientId);
        if (!sender || !receiver || sender.email !== user.email) return reply(res, 404, { error: 'Call participant is no longer connected.' });
        if (!['offer', 'answer', 'ice'].includes(body.kind)) return reply(res, 400, { error: 'Invalid call signal.' });
        const queue = callSignals.get(toClientId) || [];
        if (queue.length >= 300) queue.splice(0, queue.length - 299);
        queue.push({ fromClientId, name: sender.name, kind: body.kind, data: body.data });
        callSignals.set(toClientId, queue);
        return reply(res, 202, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/call/leave') {
        const body = await readBody(req);
        const clientId = String(body.clientId || '');
        if (callRoom.get(clientId)?.email === user.email) {
          for (const [id, queue] of callSignals) {
            if (id !== clientId && callRoom.has(id)) {
              queue.push({ fromClientId: clientId, name: callRoom.get(clientId).name, kind: 'leave' });
              callSignals.set(id, queue);
            }
          }
          callRoom.delete(clientId);
          callSignals.delete(clientId);
        }
        return reply(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/messages') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text || text.length > 2000) return reply(res, 400, { error: 'Messages must be between 1 and 2,000 characters.' });
        const message = { id: crypto.randomUUID(), email: user.email, name: user.name, role: user.role, text, createdAt: new Date().toISOString() };
        db.messages.push(message);
        if (db.messages.length > 1000) db.messages.splice(0, db.messages.length - 1000);
        persist();
        return reply(res, 201, { message });
      }
      const kickMatch = url.pathname.match(/^\/api\/members\/([^/]+)$/);
      if (req.method === 'DELETE' && kickMatch) {
        if (user.role !== 'leader') return reply(res, 403, { error: 'Only the community leader can remove members.' });
        const email = decodeURIComponent(kickMatch[1]).toLowerCase();
        if (email === user.email) return reply(res, 400, { error: 'The leader cannot remove their own account.' });
        const index = db.users.findIndex(item => item.email === email);
        if (index < 0) return reply(res, 404, { error: 'Member not found.' });
        db.users.splice(index, 1);
        db.banned.push(email);
        for (const [token, sessionEmail] of sessions) if (sessionEmail === email) sessions.delete(token);
        persist();
        return reply(res, 200, { ok: true });
      }
      return reply(res, 404, { error: 'Not found.' });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    reply(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    reply(res, 500, { error: 'Something went wrong. Please try again.' });
    console.error(error);
  }
});

server.listen(PORT, HOST, () => console.log(`Deen Truthverse is running on port ${PORT}`));
