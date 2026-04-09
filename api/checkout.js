// POST /api/checkout
// Creates a Paddle transaction and returns the checkout URL.
// Body: { priceId: "pri_...", installId: "uuid", token: "auth_token" }
// Requires auth. Links payment to user email via custom_data.
const { cors, paddleRequest, PADDLE_API_KEY, PADDLE_ENV, BASE_URL, isValidInstallId, initUser, getRedis } = require('../lib/helpers');

const PRICE_MAP = {
  pro: process.env.PRICE_PRO || 'pri_01kkwtx0kh2skzrzjbxgmgqngd',
  enterprise: process.env.PRICE_ENTERPRISE || 'pri_01kkwtyfwvrwspy654f56h4n5d',
  lifetimePk: process.env.PRICE_ONE_TIME_ID || 'pri_01knfqkcbhqbnwhq5k1ace3sd9',
  lifetimeIntl: process.env.PRICE_ONE_TIME_INTL_ID || 'pri_01knfsscfv6njhwwb40k8p6mwz',
  fallback: process.env.PRICE_CHECKOUT_FALLBACK_ID || process.env.PRICE_COURSE_ID || '',
};

function resolvePriceIds({ priceId, pack, country, currency }) {
  const requested = String(priceId || '').trim();
  const packKey = String(pack || '').trim().toLowerCase();
  const normalizedCountry = String(country || '').trim();
  const normalizedCurrency = String(currency || '').trim().toUpperCase();

  const candidates = [];
  const allowed = new Set(Object.values(PRICE_MAP).filter(Boolean));
  if (requested && requested.startsWith('pri_')) {
    candidates.push(requested);
  }

  const isPakistan = normalizedCountry === 'Pakistan' || normalizedCurrency === 'PKR';

  if (packKey === 'pro') {
    candidates.push(PRICE_MAP.pro);
  } else if (packKey === 'enterprise') {
    candidates.push(PRICE_MAP.enterprise);
  } else if (packKey === 'lifetime') {
    candidates.push(isPakistan ? PRICE_MAP.lifetimePk : PRICE_MAP.lifetimeIntl);
    candidates.push(isPakistan ? PRICE_MAP.lifetimeIntl : PRICE_MAP.lifetimePk);
    candidates.push(PRICE_MAP.fallback);
  }

  const deduped = [];
  const seen = new Set();
  for (const id of candidates) {
    if (!id || !id.startsWith('pri_')) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (allowed.has(id) || requested === id) {
      deduped.push(id);
    }
  }
  return deduped;
}

function isPriceIdNotFoundError(data) {
  const detail = String(data?.error?.detail || '').toLowerCase();
  return detail.includes('price_ids could not be found') || detail.includes('price ids could not be found');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!PADDLE_API_KEY) {
    return res.status(500).json({ error: 'PADDLE_API_KEY not configured' });
  }

  const { priceId, installId, token, pack, country, currency } = req.body || {};

  // ── Verify auth token ──
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'Please sign in to complete your purchase.' });
  }
  const redis = getRedis();
  const sessionRaw = await redis.get(`session:${token}`);
  if (!sessionRaw) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  const session = JSON.parse(sessionRaw);
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
    let resolvedPriceId = null;
    for (const candidatePriceId of resolvedPriceIds) {
      const attempt = await paddleRequest('/transactions', {
        items: [{ price_id: candidatePriceId, quantity: 1 }],
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

      if (!isPriceIdNotFoundError(attempt)) {
        data = attempt;
        break;
      }
    }

    if (!data) {
      return res.status(502).json({
        error: 'Could not create checkout',
        detail: 'No configured Paddle price IDs worked for this selection.',
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
      const checkoutDomain = (process.env.PADDLE_ENV === 'live' || process.env.PADDLE_ENV === 'production')
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

