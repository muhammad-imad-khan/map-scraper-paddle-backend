// POST /api/course-checkout
// Creates a Paddle transaction for course purchase in sandbox/live based on backend env.
// Body: { email: "buyer@example.com", name?: "Buyer", priceId?: "pri_..." }
const { cors, paddleRequest, PADDLE_API_KEY, PADDLE_ENV, BASE_URL, getRedis } = require('../lib/helpers');

const DEFAULT_COURSE_PRICE_ID = process.env.PRICE_COURSE_ID || 'pri_01knmdy54t0wd91ne4tspntxty';
const DEFAULT_COURSE_INTL_PRICE_ID = process.env.PRICE_COURSE_INTL_ID || DEFAULT_COURSE_PRICE_ID;

function resolveCoursePriceId({ requestedPriceId, country, currency }) {
  const requested = String(requestedPriceId || '').trim();
  const normalizedCountry = String(country || '').trim();
  const normalizedCurrency = String(currency || '').trim().toUpperCase();
  const allowed = new Set([DEFAULT_COURSE_PRICE_ID, DEFAULT_COURSE_INTL_PRICE_ID].filter(Boolean));

  if (requested && allowed.has(requested)) return requested;

  const isPakistan = normalizedCountry === 'Pakistan' || normalizedCurrency === 'PKR';
  return isPakistan ? DEFAULT_COURSE_PRICE_ID : DEFAULT_COURSE_INTL_PRICE_ID;
}

function sanitize(str, maxLen = 120) {
  return String(str || '').trim().slice(0, maxLen);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!PADDLE_API_KEY) {
    return res.status(500).json({ error: 'PADDLE_API_KEY not configured' });
  }

  const email = sanitize(req.body?.email, 254).toLowerCase();
  const name = sanitize(req.body?.name, 100);
  const requestedPriceId = sanitize(req.body?.priceId, 64);
  const country = sanitize(req.body?.country, 80);
  const currency = sanitize(req.body?.currency, 8).toUpperCase();
  const priceId = resolveCoursePriceId({ requestedPriceId, country, currency });

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  if (!priceId || !priceId.startsWith('pri_')) {
    return res.status(400).json({
      error: 'Missing or invalid priceId.',
      detail: 'Please refresh and re-select your country before checkout.',
    });
  }

  try {
    const redis = getRedis();
    const userKey = `user:${email}`;
    const userRaw = await redis.get(userKey);
    const now = new Date().toISOString();
    const userData = userRaw ? JSON.parse(userRaw) : { email, name, createdAt: now, purchases: [] };
    userData.email = email;
    if (name) userData.name = name;
    userData.purchases = Array.isArray(userData.purchases) ? userData.purchases : [];

    const data = await paddleRequest('/transactions', {
      items: [{ price_id: priceId, quantity: 1 }],
      custom_data: { email, name, coursePurchase: true },
    });

    userData.purchases.push({
      priceId,
      installId: null,
      status: 'pending',
      createdAt: now,
      txnId: data?.data?.id || null,
      label: 'Lead Gen x AI Web Design Course',
      course: true,
      courseId: process.env.DEFAULT_COURSE_ID || 'lead-gen-ai-web-design',
    });
    await redis.set(userKey, JSON.stringify(userData));

    if (data?.data?.id) {
      const txnId = data.data.id;
      const checkoutDomain = (PADDLE_ENV === 'live' || PADDLE_ENV === 'production')
        ? 'https://checkout.paddle.com'
        : 'https://sandbox-checkout.paddle.com';
      return res.status(200).json({
        checkoutUrl: `${checkoutDomain}/?_ptxn=${txnId}`,
        txnId,
        paddleEnv: PADDLE_ENV,
      });
    }

    console.error('Course checkout Paddle response:', JSON.stringify(data));
    return res.status(502).json({
      error: 'Could not create checkout',
      detail: data?.error?.detail || data?.error?.type || 'Unknown',
      paddleEnv: PADDLE_ENV,
      baseUrl: BASE_URL,
    });
  } catch (err) {
    console.error('Course checkout error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

