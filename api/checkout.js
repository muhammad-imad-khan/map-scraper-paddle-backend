// POST /api/checkout
// Creates a Paddle transaction and returns the checkout URL.
// Body: { priceId: "pri_...", installId: "uuid", token: "auth_token" }
// Requires auth. Links payment to user email via custom_data.
const { cors, paddleRequest, PADDLE_API_KEY, isValidInstallId, initUser, getRedis } = require('./_helpers');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!PADDLE_API_KEY) {
    return res.status(500).json({ error: 'PADDLE_API_KEY not configured' });
  }

  const { priceId, installId, token } = req.body || {};

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

  if (!priceId || !priceId.startsWith('pri_')) {
    return res.status(400).json({ error: 'Missing or invalid priceId' });
  }
  if (!isValidInstallId(installId)) {
    return res.status(400).json({ error: 'Missing or invalid installId' });
  }

  // Ensure user exists in Redis before checkout
  await initUser(installId);

  try {
    // Create a transaction via Paddle API with custom_data containing installId + user email
    const data = await paddleRequest('/transactions', {
      items: [{ price_id: priceId, quantity: 1 }],
      custom_data: { installId, email: userEmail },
    });

    // Record checkout attempt on user profile
    const userKey = `user:${userEmail}`;
    const userRaw = await redis.get(userKey);
    if (userRaw) {
      const userData = JSON.parse(userRaw);
      if (!userData.purchases) userData.purchases = [];
      userData.purchases.push({
        priceId,
        installId,
        status: 'pending',
        createdAt: new Date().toISOString(),
        txnId: data?.data?.id || null,
      });
      await redis.set(userKey, JSON.stringify(userData));
    }

    if (data?.data?.checkout?.url) {
      return res.status(200).json({ checkoutUrl: data.data.checkout.url });
    }

    if (data?.data?.id) {
      const txnId = data.data.id;
      const checkoutDomain = process.env.PADDLE_ENV === 'live'
        ? 'https://checkout.paddle.com'
        : 'https://sandbox-checkout.paddle.com';
      return res.status(200).json({ checkoutUrl: `${checkoutDomain}/transaction/${txnId}` });
    }

    console.error('Paddle /transactions response:', JSON.stringify(data));
    return res.status(502).json({ error: 'Could not create checkout', detail: data?.error?.detail || 'Unknown' });
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
