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
};

function resolvePriceId({ priceId, pack, country, currency }) {
  const requested = String(priceId || '').trim();
  const packKey = String(pack || '').trim().toLowerCase();
  const normalizedCountry = String(country || '').trim();
  const normalizedCurrency = String(currency || '').trim().toUpperCase();

  const allowed = new Set(Object.values(PRICE_MAP).filter(Boolean));
  if (requested && allowed.has(requested)) return requested;

  const isPakistan = normalizedCountry === 'Pakistan' || normalizedCurrency === 'PKR';
  if (packKey === 'pro') return PRICE_MAP.pro;
  if (packKey === 'enterprise') return PRICE_MAP.enterprise;
  if (packKey === 'lifetime') return isPakistan ? PRICE_MAP.lifetimePk : PRICE_MAP.lifetimeIntl;
  return null;
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

  const resolvedPriceId = resolvePriceId({ priceId, pack, country, currency });
  if (!resolvedPriceId) {
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
    // Create a transaction via Paddle API with custom_data containing installId + user email
    const data = await paddleRequest('/transactions', {
      items: [{ price_id: resolvedPriceId, quantity: 1 }],
      custom_data: { installId, email: userEmail },
    });

    // Record checkout attempt on user profile
    const userKey = `user:${userEmail}`;
    const userRaw = await redis.get(userKey);
    if (userRaw) {
      const userData = JSON.parse(userRaw);
      if (!userData.purchases) userData.purchases = [];
      userData.purchases.push({
        priceId: resolvedPriceId,
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
    return res.status(502).json({ error: 'Could not create checkout', detail: data?.error?.detail || data?.error?.type || 'Unknown', paddleEnv: PADDLE_ENV, baseUrl: BASE_URL });
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

