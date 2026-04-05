// POST /api/auth
// Actions: register, login, me, logout
// Stores users in Redis with PBKDF2 password hashing
const crypto = require('crypto');
const { cors, getRedis } = require('./_helpers');

const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

const authKeys = {
  user:    (email) => `user:${email.toLowerCase().trim()}`,
  session: (token) => `session:${token}`,
};

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 100000, 64, 'sha512', (err, derived) => {
      if (err) reject(err);
      else resolve(derived.toString('hex'));
    });
  });
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function sanitize(str, maxLen = 100) {
  return String(str || '').trim().slice(0, maxLen);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  const redis = getRedis();

  try {

    // ── REGISTER ──
    if (action === 'register') {
      const email = sanitize(req.body.email, 254).toLowerCase();
      const password = req.body.password || '';
      const name = sanitize(req.body.name, 100);

      if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });

      const userKey = authKeys.user(email);
      const existing = await redis.get(userKey);
      if (existing) return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });

      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = await hashPassword(password, salt);
      const token = generateToken();

      const userData = {
        name,
        email,
        passwordHash,
        salt,
        createdAt: new Date().toISOString(),
        purchases: [],
      };

      await redis.set(userKey, JSON.stringify(userData));
      await redis.set(authKeys.session(token), JSON.stringify({ email, name }), 'EX', SESSION_TTL);

      return res.status(201).json({ ok: true, token, user: { name, email } });
    }

    // ── LOGIN ──
    if (action === 'login') {
      const email = sanitize(req.body.email, 254).toLowerCase();
      const password = req.body.password || '';

      if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

      const userKey = authKeys.user(email);
      const raw = await redis.get(userKey);
      if (!raw) return res.status(401).json({ error: 'Invalid email or password.' });

      const userData = JSON.parse(raw);
      const hash = await hashPassword(password, userData.salt);
      if (hash !== userData.passwordHash) return res.status(401).json({ error: 'Invalid email or password.' });

      const token = generateToken();
      await redis.set(authKeys.session(token), JSON.stringify({ email: userData.email, name: userData.name }), 'EX', SESSION_TTL);

      return res.status(200).json({ ok: true, token, user: { name: userData.name, email: userData.email } });
    }

    // ── ME (validate token) ──
    if (action === 'me') {
      const token = sanitize(req.body.token, 64);
      if (!token) return res.status(401).json({ error: 'No token provided.' });

      const raw = await redis.get(authKeys.session(token));
      if (!raw) return res.status(401).json({ error: 'Session expired. Please log in again.' });

      const session = JSON.parse(raw);
      return res.status(200).json({ ok: true, user: session });
    }

    // ── LOGOUT ──
    if (action === 'logout') {
      const token = sanitize(req.body.token, 64);
      if (token) await redis.del(authKeys.session(token));
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid action.' });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};
