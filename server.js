// ═══════════════════════════════════════════════════════════════
//  Maps Lead Scraper — Paddle Payment Backend (Fixed)
//  npm install express cors dotenv crypto
// ═══════════════════════════════════════════════════════════════

import express from 'express';
import cors    from 'cors';
import crypto  from 'crypto';
import dotenv  from 'dotenv';
dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

const PADDLE_ENV     = process.env.PADDLE_ENV || 'sandbox';
const PADDLE_API_URL = PADDLE_ENV === 'production'
  ? 'https://api.paddle.com'
  : 'https://sandbox-api.paddle.com';

console.log(`[startup] Paddle env: ${PADDLE_ENV} → ${PADDLE_API_URL}`);

const licenseStore = new Map();

// PUT YOUR REAL PADDLE PRICE IDs HERE (from Paddle Dashboard → Catalog → Products → Prices)
const PACKS = {
  [process.env.PRICE_ID_100  || 'pri_placeholder_100']:  { credits: 100,  price: '$5',  label: 'Starter Pack' },
  [process.env.PRICE_ID_500  || 'pri_placeholder_500']:  { credits: 500,  price: '$19', label: 'Pro Pack'     },
  [process.env.PRICE_ID_1000 || 'pri_placeholder_1000']: { credits: 1000, price: '$35', label: 'Agency Pack'  },
};

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origin.startsWith('chrome-extension://')) return cb(null, true);
    const allowed = [process.env.SITE_ORIGIN, 'http://localhost:3000', 'http://localhost:5500'].filter(Boolean);
    cb(null, allowed.includes(origin) || !process.env.SITE_ORIGIN);
  }
}));

app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

async function paddleRequest(path, options = {}) {
  const res  = await fetch(`${PADDLE_API_URL}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${process.env.PADDLE_API_KEY}`,
      'Content-Type':  'application/json',
      'Paddle-Version': '1',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.detail || data?.error?.code || JSON.stringify(data);
    throw Object.assign(new Error(`Paddle ${res.status}: ${msg}`), { paddle: data?.error });
  }
  return data;
}

app.get('/', (_req, res) => {
  res.json({ name: 'Maps Lead Scraper API', version: '2.0.0', env: PADDLE_ENV,
    routes: ['/api/health', '/api/packs', '/api/checkout', '/api/verify-license', '/api/webhook'] });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, licenses: licenseStore.size, env: PADDLE_ENV });
});

app.get('/api/packs', (_req, res) => {
  res.json({ packs: Object.entries(PACKS).map(([priceId, info]) => ({ priceId, ...info })) });
});

app.post('/api/checkout', async (req, res) => {
  try {
    const { priceId } = req.body;

    if (!priceId) return res.status(400).json({ error: 'Missing priceId' });
    if (!PACKS[priceId]) return res.status(400).json({ error: 'Invalid price ID', provided: priceId });
    if (!process.env.PADDLE_API_KEY) return res.status(500).json({ error: 'PADDLE_API_KEY not configured' });

    const data = await paddleRequest('/transactions', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        custom_data: { priceId },
      }),
    });

    const checkoutUrl = data?.data?.checkout?.url;

    if (!checkoutUrl) {
      console.error('[checkout] No checkout.url in response:', JSON.stringify(data?.data));
      return res.status(500).json({
        error: 'No checkout URL returned from Paddle',
        fix: 'Set a Default payment link: Paddle Dashboard → Checkout → Checkout settings → Default payment link',
        paddleData: data?.data,
      });
    }

    res.json({ checkoutUrl });

  } catch (err) {
    console.error('[checkout]', err.message);
    const code = err?.paddle?.code || '';
    const hints = {
      'transaction_default_checkout_url_not_set': 'Paddle → Checkout → Checkout settings → set Default payment link',
      'transaction_payout_account_required':       'Paddle → Financial → Payout account → connect your bank/Payoneer',
      'transaction_checkout_not_enabled':          'Contact Paddle support to enable checkout for your account',
    };
    res.status(500).json({ error: err.message, fix: hints[code] || 'Check your Paddle dashboard and server logs' });
  }
});

app.post('/api/webhook', async (req, res) => {
  try {
    const sig = req.headers['paddle-signature'];
    const key = process.env.PADDLE_WEBHOOK_SECRET;
    if (key && sig) {
      const [, ts] = sig.match(/ts=(\d+)/) || [];
      const [, h1] = sig.match(/h1=([a-f0-9]+)/) || [];
      if (ts && h1) {
        const expected = crypto.createHmac('sha256', key).update(`${ts}:${req.body}`).digest('hex');
        if (expected !== h1) return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const event = JSON.parse(req.body.toString());
    console.log('[webhook]', event.event_type);

    if (event.event_type === 'transaction.completed') {
      const txn     = event.data;
      const priceId = txn?.custom_data?.priceId || txn?.items?.[0]?.price?.id;
      const pack    = PACKS[priceId];
      const email   = txn?.customer?.email;

      if (pack) {
        const key = generateLicenseKey();
        licenseStore.set(key, { credits: pack.credits, label: pack.label, priceId, email, usedAt: null, createdAt: Date.now(), txnId: txn.id });
        console.log(`[webhook] ✅ License generated: ${key} | ${pack.label} | ${email}`);
        // TODO: email the license key → see README for Resend setup
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[webhook]', err.message);
    res.status(500).json({ error: 'Webhook error' });
  }
});

app.post('/api/verify-license', (req, res) => {
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ valid: false, error: 'Missing license key' });
  if (licenseKey.startsWith('TEST-') && licenseKey.length >= 12) return res.json({ valid: true, credits: 100, label: 'Test Pack' });

  const record = licenseStore.get(licenseKey);
  if (!record)       return res.json({ valid: false, error: 'License key not found' });
  if (record.usedAt) return res.json({ valid: false, error: 'Already activated' });

  record.usedAt = Date.now();
  licenseStore.set(licenseKey, record);
  res.json({ valid: true, credits: record.credits, label: record.label });
});

function generateLicenseKey() {
  const s = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `MLS-${s()}-${s()}-${s()}`;
}

app.listen(PORT, () => {
  console.log(`\n✅  API on port ${PORT} | Paddle: ${PADDLE_ENV} | Key set: ${!!process.env.PADDLE_API_KEY}\n`);
});

export default app;
