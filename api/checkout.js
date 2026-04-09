// POST /api/checkout
// Creates a Paddle transaction and returns the checkout URL.
// Body: { priceId: "pri_...", installId: "uuid", token: "auth_token" }
// Requires auth. Links payment to user email via custom_data.
const { cors, paddleRequest, PADDLE_API_KEY, PADDLE_ENV, BASE_URL, isValidInstallId, initUser, getRedis, FRONTEND_URL, PRICE_IDS } = require('../lib/helpers');
const crypto = require('crypto');

const COURSE_PRICE_IDS = new Set([
  String(PRICE_IDS.course || '').trim(),
  String(PRICE_IDS.courseIntl || '').trim(),
].filter(Boolean));

function normalizeToolPriceId(value) {
  const normalized = String(value || '').trim();
  if (!normalized.startsWith('pri_')) return '';
  if (COURSE_PRICE_IDS.has(normalized)) return '';
  return normalized;
}

const PRICE_MAP = {
  pro: normalizeToolPriceId(PRICE_IDS.pro),
  enterprise: normalizeToolPriceId(PRICE_IDS.enterprise),
  lifetimePk: normalizeToolPriceId(PRICE_IDS.oneTimePk),
  lifetimeIntl: normalizeToolPriceId(PRICE_IDS.oneTimeIntl),
  fallback: normalizeToolPriceId(PRICE_IDS.checkoutFallback),
};

const ALL_TOOL_PRICE_IDS = Object.values(PRICE_MAP).filter(Boolean);

function getPackCandidatePriceIds(packKey, isPakistan) {
  if (packKey === 'pro') return [PRICE_MAP.pro];
  if (packKey === 'enterprise') return [PRICE_MAP.enterprise];
  if (packKey === 'lifetime') {
    return [
      isPakistan ? PRICE_MAP.lifetimePk : PRICE_MAP.lifetimeIntl,
      isPakistan ? PRICE_MAP.lifetimeIntl : PRICE_MAP.lifetimePk,
      PRICE_MAP.fallback,
    ];
  }
  return [];
}

function resolvePriceIds({ priceId, pack, country, currency }) {
  const requested = String(priceId || '').trim();
  const packKey = String(pack || '').trim().toLowerCase();
  const normalizedCountry = String(country || '').trim();
  const normalizedCurrency = String(currency || '').trim().toUpperCase();
  const isPakistan = normalizedCountry === 'Pakistan' || normalizedCurrency === 'PKR';
  const packCandidates = getPackCandidatePriceIds(packKey, isPakistan).filter(Boolean);

  const candidates = [];
  const requestedAllowed = requested
    && requested.startsWith('pri_')
    && (packKey ? packCandidates.includes(requested) : ALL_TOOL_PRICE_IDS.includes(requested));
  if (requestedAllowed) {
    candidates.push(requested);
  }

  if (packKey) {
    candidates.push(...packCandidates);
  }

  const deduped = [];
  const seen = new Set();
  for (const id of candidates) {
    if (!id || !id.startsWith('pri_')) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}

function normalizeClientId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (!/^[a-zA-Z0-9_-]{16,120}$/.test(normalized)) return '';
  return normalized;
}

function buildSessionFingerprint(req) {
  const userAgent = String(req?.headers?.['user-agent'] || '').trim();
  const language = String(req?.headers?.['accept-language'] || '').trim();
  const secChUa = String(req?.headers?.['sec-ch-ua'] || '').trim();
  const secChPlatform = String(req?.headers?.['sec-ch-ua-platform'] || '').trim();
  const raw = `${userAgent}|${language}|${secChUa}|${secChPlatform}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!PADDLE_API_KEY) {
    return res.status(500).json({ error: 'PADDLE_API_KEY not configured' });
  }

  const { priceId, installId, token, clientId: rawClientId, pack, country, currency } = req.body || {};

  // ── Verify auth token ──
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'Please sign in to complete your purchase.' });
  }
  const clientId = normalizeClientId(rawClientId || req.headers['x-client-id']);
  const redis = getRedis();
  const sessionRaw = await redis.get(`session:${token}`);
  if (!sessionRaw) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  const session = JSON.parse(sessionRaw);
  if (session?.clientId) {
    if (!clientId || clientId !== session.clientId) {
      return res.status(401).json({ error: 'Session is bound to a different browser. Please sign in again.' });
    }
  }
  if (session?.fingerprint) {
    const fingerprint = buildSessionFingerprint(req);
    if (fingerprint !== session.fingerprint) {
      return res.status(401).json({ error: 'Session verification failed. Please sign in again.' });
    }
  }
  const userEmail = session.email;

  const resolvedPriceIds = resolvePriceIds({ priceId, pack, country, currency });
  if (!resolvedPriceIds.length) {
    return res.status(400).json({
      error: 'Missing or invalid priceId',
      detail: 'Please refresh pricing and try again. Selected region pricing may be unavailable.',
    });
  }
  if (!isValidInstallId(installId)) {
    return res.status(400).json({ error: 'Missing or invalid installId' });
  }

  // Ensure user exists in Redis before checkout
  await initUser(installId);

  try {
    // Try candidate price IDs in order to avoid hard failures when one regional price is misconfigured.
    let data = null;
    let lastAttempt = null;
    let resolvedPriceId = null;
    for (const candidatePriceId of resolvedPriceIds) {
      const attempt = await paddleRequest('/transactions', {
        items: [{ price_id: candidatePriceId, quantity: 1 }],
          checkout: { url: `${FRONTEND_URL}/payment/` },
        custom_data: {
          installId,
          email: userEmail,
          purchaseKind: String(pack || '').trim().toLowerCase() || 'unknown',
          requestedCountry: country || null,
          requestedCurrency: currency || null,
        },
      });

      if (attempt?.data?.id || attempt?.data?.checkout?.url) {
        data = attempt;
        resolvedPriceId = candidatePriceId;
        break;
      }

      lastAttempt = attempt;
    }

    if (!data) {
      return res.status(502).json({
        error: 'Could not create checkout',
        detail: lastAttempt?.error?.detail || lastAttempt?.error?.type || 'No configured Paddle price IDs worked for this selection.',
        triedPriceIds: resolvedPriceIds,
        paddleEnv: PADDLE_ENV,
      });
    }

    // Record checkout attempt on user profile
    const userKey = `user:${userEmail}`;
    const userRaw = await redis.get(userKey);
    if (userRaw) {
      const userData = JSON.parse(userRaw);
      if (!userData.purchases) userData.purchases = [];
      userData.purchases.push({
        priceId: resolvedPriceId || resolvedPriceIds[0],
        installId,
        status: 'pending',
        createdAt: new Date().toISOString(),
        txnId: data?.data?.id || null,
      });
      await redis.set(userKey, JSON.stringify(userData));
    }

    if (data?.data?.checkout?.url) {
      return res.status(200).json({ checkoutUrl: data.data.checkout.url, txnId: data?.data?.id || null });
    }

    if (data?.data?.id) {
      const txnId = data.data.id;
      const checkoutDomain = (PADDLE_ENV === 'live' || PADDLE_ENV === 'production')
        ? 'https://checkout.paddle.com'
        : 'https://sandbox-checkout.paddle.com';
      return res.status(200).json({ checkoutUrl: `${checkoutDomain}/transaction/${txnId}`, txnId });
    }

    console.error('Paddle /transactions response:', JSON.stringify(data));
    return res.status(502).json({ error: 'Could not create checkout', detail: data?.error?.detail || data?.error?.type || 'Unknown', triedPriceIds: resolvedPriceIds, paddleEnv: PADDLE_ENV, baseUrl: BASE_URL });
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

