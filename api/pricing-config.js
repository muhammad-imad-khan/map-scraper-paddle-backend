// GET /api/pricing-config
// - return public pricing mode/config (used by web + extension)
// POST /api/pricing-config
// - Admin only: update pricing mode
const { cors, getRedis } = require('./_helpers');

const PRICING_MODE_KEY = 'cfg:pricing_mode';
const PRICING_MODE_CREDIT = 'credit_based';
const PRICING_MODE_ONE_TIME = 'one_time';
const VALID_MODES = new Set([PRICING_MODE_CREDIT, PRICING_MODE_ONE_TIME]);

function getAdminKey(req) {
  const fromHeader = (req.headers['x-admin-key'] || '').toString().trim();
  if (fromHeader) return fromHeader;
  const auth = (req.headers.authorization || '').toString();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return resolve(req.body);
    }
    if (Buffer.isBuffer(req.body)) {
      try {
        return resolve(JSON.parse(req.body.toString('utf8')));
      } catch {
        return resolve({});
      }
    }
    if (typeof req.body === 'string' && req.body.length > 0) {
      try {
        return resolve(JSON.parse(req.body));
      } catch {
        return resolve({});
      }
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

async function getPricingMode() {
  try {
    const redis = getRedis();
    const raw = (await redis.get(PRICING_MODE_KEY)) || '';
    return VALID_MODES.has(raw) ? raw : PRICING_MODE_CREDIT;
  } catch {
    return PRICING_MODE_CREDIT;
  }
}

function buildPublicPricing(mode) {
  const oneTimePrice = process.env.PRICE_ONE_TIME_LABEL || '$5.99';
  const oneTimePriceId = process.env.PRICE_ONE_TIME_ID || 'pri_01knfqkcbhqbnwhq5k1ace3sd9';
  const oneTimeIntlPrice = process.env.PRICE_ONE_TIME_INTL_LABEL || '$20';
  const oneTimeIntlPriceId = process.env.PRICE_ONE_TIME_INTL_ID || 'pri_01knfsscfv6njhwwb40k8p6mwz';
  return {
    mode,
    plans: {
      pro: { price: '$5', credits: 500, label: 'Pro Pack' },
      enterprise: { price: '$25', credits: 2500, label: 'Enterprise Pack' },
      oneTime: { price: oneTimePrice, label: 'Lifetime License', priceId: oneTimePriceId },
      oneTimeIntl: { price: oneTimeIntlPrice, label: 'Lifetime License', priceId: oneTimeIntlPriceId },
    },
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'POST') {
    const configuredAdminKey = (process.env.ADMIN_API_KEY || '').trim();
    if (!configuredAdminKey) {
      return res.status(500).json({ error: 'ADMIN_API_KEY is not configured.' });
    }
    if (getAdminKey(req) !== configuredAdminKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const body = await readBody(req);
    if (body.action !== 'setPricingMode') {
      return res.status(400).json({ error: 'Unsupported action.' });
    }
    if (!VALID_MODES.has(body.mode)) {
      return res.status(400).json({ error: 'Invalid mode.' });
    }

    try {
      const redis = getRedis();
      await redis.set(PRICING_MODE_KEY, body.mode);
      return res.status(200).json({ ok: true, mode: body.mode, pricing: buildPublicPricing(body.mode) });
    } catch (err) {
      console.error('Pricing-config set mode error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const mode = await getPricingMode();
  return res.status(200).json({ mode, pricing: buildPublicPricing(mode) });
};
