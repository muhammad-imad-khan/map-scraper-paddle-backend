// POST /api/auth
// Actions: register, login, me, logout
// Stores users in Redis with PBKDF2 password hashing
const crypto = require('crypto');
const { cors, getRedis, PRICE_IDS } = require('../lib/helpers');

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

function normalizeClientId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (!/^[a-zA-Z0-9_-]{16,120}$/.test(normalized)) return '';
  return normalized;
}

function readClientId(req) {
  return normalizeClientId(req?.body?.clientId || req?.headers?.['x-client-id']);
}

function buildSessionFingerprint(req) {
  const userAgent = String(req?.headers?.['user-agent'] || '').trim();
  const language = String(req?.headers?.['accept-language'] || '').trim();
  const secChUa = String(req?.headers?.['sec-ch-ua'] || '').trim();
  const secChPlatform = String(req?.headers?.['sec-ch-ua-platform'] || '').trim();
  const raw = `${userAgent}|${language}|${secChUa}|${secChPlatform}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

async function createSession(redis, token, payload) {
  await redis.set(authKeys.session(token), JSON.stringify(payload), 'EX', SESSION_TTL);
}

async function validateSession(redis, req, token, clientId, { touch = false } = {}) {
  const raw = await redis.get(authKeys.session(token));
  if (!raw) return { ok: false, error: 'Session expired. Please log in again.' };

  const session = JSON.parse(raw);
  if (!session || !session.email) return { ok: false, error: 'Session invalid. Please log in again.' };

  if (session.clientId) {
    if (!clientId) return { ok: false, error: 'Session verification failed. Please log in again.' };
    if (session.clientId !== clientId) return { ok: false, error: 'Session is bound to a different browser. Please log in on this device.' };
  }

  if (session.fingerprint) {
    const currentFingerprint = buildSessionFingerprint(req);
    if (session.fingerprint !== currentFingerprint) {
      return { ok: false, error: 'Session verification failed. Please log in again.' };
    }
  }

  if (touch) {
    session.lastSeenAt = new Date().toISOString();
    await createSession(redis, token, session);
  }

  return { ok: true, session };
}

function getLifetimePriceIds() {
  const coursePriceIds = new Set([
    String(PRICE_IDS.course || '').trim(),
    String(PRICE_IDS.courseIntl || '').trim(),
  ].filter(Boolean));
  return new Set([
    PRICE_IDS.oneTimePk,
    PRICE_IDS.oneTimeIntl,
    PRICE_IDS.checkoutFallback,
  ].filter((priceId) => {
    const normalized = String(priceId || '').trim();
    return normalized && !coursePriceIds.has(normalized);
  }));
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
      const clientId = readClientId(req);

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
      await createSession(redis, token, {
        email,
        name,
        clientId,
        fingerprint: buildSessionFingerprint(req),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      });

      return res.status(201).json({ ok: true, token, clientId, user: { name, email } });
    }

    // ── LOGIN ──
    if (action === 'login') {
      const email = sanitize(req.body.email, 254).toLowerCase();
      const password = req.body.password || '';
      const clientId = readClientId(req);

      if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

      const userKey = authKeys.user(email);
      const raw = await redis.get(userKey);
      if (!raw) return res.status(401).json({ error: 'Invalid email or password.' });

      const userData = JSON.parse(raw);
      const hash = await hashPassword(password, userData.salt);
      if (hash !== userData.passwordHash) return res.status(401).json({ error: 'Invalid email or password.' });

      const token = generateToken();
      await createSession(redis, token, {
        email: userData.email,
        name: userData.name,
        clientId,
        fingerprint: buildSessionFingerprint(req),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      });

      return res.status(200).json({ ok: true, token, clientId, user: { name: userData.name, email: userData.email } });
    }

    // ── ME (validate token) ──
    if (action === 'me') {
      const token = sanitize(req.body.token, 64);
      const clientId = readClientId(req);
      if (!token) return res.status(401).json({ error: 'No token provided.' });

      const validation = await validateSession(redis, req, token, clientId, { touch: true });
      if (!validation.ok) return res.status(401).json({ error: validation.error });

      const session = validation.session;
      const userRaw = await redis.get(authKeys.user(session.email));
      const userData = userRaw ? JSON.parse(userRaw) : null;
      const purchases = Array.isArray(userData?.purchases) ? userData.purchases : [];
      const lifetimePriceIds = getLifetimePriceIds();
      const hasLifetimeAccess = purchases.some(p =>
        p && p.status === 'completed' && (
          lifetimePriceIds.has(p.priceId) ||
          String(p.label || '').toLowerCase().includes('lifetime') ||
          p.unlimited === true
        )
      );
      return res.status(200).json({
        ok: true,
        user: {
          name: session.name,
          email: session.email,
          createdAt: userData?.createdAt || null,
        },
        purchases,
        entitlements: {
          lifetimeAccess: hasLifetimeAccess,
          zipDownload: hasLifetimeAccess,
        },
      });
    }

    // ── LOGOUT ──
    if (action === 'logout') {
      const token = sanitize(req.body.token, 64);
      const clientId = readClientId(req);
      if (token) {
        const validation = await validateSession(redis, req, token, clientId);
        if (validation.ok) {
          await redis.del(authKeys.session(token));
        } else {
          return res.status(401).json({ error: validation.error });
        }
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid action.' });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};

