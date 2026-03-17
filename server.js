// ═══════════════════════════════════════════════════════════════
//  Maps Lead Scraper — Paddle Payment Backend
//
//  Why Paddle?
//  • Works for Pakistan merchants (SWIFT / Payoneer payouts)
//  • Merchant of Record — handles VAT/GST globally for you
//  • No Stripe dependency
//
//  npm install express cors dotenv crypto
//  Deploy: Vercel / Railway / Render (free tier works)
// ═══════════════════════════════════════════════════════════════

import express  from 'express';
import cors     from 'cors';
import crypto   from 'crypto';
import dotenv   from 'dotenv';
dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── In-memory license store (replace with a DB in production) ──
// For production: use Supabase free tier or PlanetScale free tier
const licenseStore = new Map(); // licenseKey → { credits, productId, used }

// ── Credit packs — match your Paddle product IDs ───────────────
// Create these products in your Paddle dashboard at paddle.com
const PACKS = {
  'pro_01kkwtmnxnjcp2ja76dps3wm63':  { credits: 100,  price: '$5',  label: 'Starter Pack' },
  'pro_01kkwtnk3zrp25a50jbzhsm6hr':  { credits: 500,  price: '$19', label: 'Pro Pack'     },
  'pro_01kkwtq5fexkarzr641bg9qj85': { credits: 1000, price: '$35', label: 'Agency Pack'  },
};
// Replace pri_100 / pri_500 / pri_1000 with your actual Paddle Price IDs
// Found in Paddle Dashboard → Catalog → Products → your product → Price ID

// ── CORS — allow extension + your website ─────────────────────
app.use(cors({
  origin: (origin, cb) => {
    const allowed = [
      process.env.SITE_ORIGIN,
      'http://localhost:3000',
      'http://localhost:5500',
    ].filter(Boolean);
    if (!origin || allowed.includes(origin) || (origin && origin.startsWith('chrome-extension://'))) {
      return cb(null, true);
    }
    cb(new Error('CORS'), false);
  }
}));

// Raw body needed for webhook signature verification
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ──────────────────────────────────────────────────────────────
//  GET /api/packs
//  Returns available credit packs (no secrets exposed)
// ──────────────────────────────────────────────────────────────
app.get('/api/packs', (_req, res) => {
  const packs = Object.entries(PACKS).map(([id, info]) => ({
    priceId: id,
    ...info
  }));
  res.json({ packs });
});

// ──────────────────────────────────────────────────────────────
//  POST /api/checkout
//  Body: { priceId: "pri_100" }
//  Returns: { checkoutUrl }
//
//  Uses Paddle's hosted checkout — no PCI scope on your server
// ──────────────────────────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  try {
    const { priceId } = req.body;
    if (!priceId || !PACKS[priceId]) {
      return res.status(400).json({ error: 'Invalid price ID' });
    }

    // Paddle Billing API v1 — create a checkout
    const response = await fetch('https://api.paddle.com/transactions', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.PADDLE_API_KEY}`,
      },
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        checkout: {
          url: process.env.SUCCESS_URL || 'https://mapsleadscraper.com/success',
        },
        custom_data: { priceId }, // we'll read this in the webhook
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[checkout] Paddle error:', data);
      return res.status(500).json({ error: data?.error?.detail || 'Checkout failed' });
    }

    // Paddle returns checkout URL in data.data.checkout.url
    const checkoutUrl = data?.data?.checkout?.url;
    if (!checkoutUrl) {
      return res.status(500).json({ error: 'No checkout URL returned' });
    }

    res.json({ checkoutUrl });

  } catch (err) {
    console.error('[checkout]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────
//  POST /api/webhook  (Paddle → your server)
//  Paddle sends this when payment completes
//  Generates a license key and stores it
//
//  Set this URL in Paddle Dashboard → Developer → Webhooks
//  Events to subscribe: transaction.completed
// ──────────────────────────────────────────────────────────────
app.post('/api/webhook', async (req, res) => {
  try {
    // Verify Paddle signature
    const signature  = req.headers['paddle-signature'];
    const webhookKey = process.env.PADDLE_WEBHOOK_SECRET;

    if (webhookKey && signature) {
      const [, ts]   = signature.match(/ts=(\d+)/)  || [];
      const [, h1]   = signature.match(/h1=([a-f0-9]+)/) || [];
      const payload  = `${ts}:${req.body.toString()}`;
      const expected = crypto.createHmac('sha256', webhookKey).update(payload).digest('hex');
      if (expected !== h1) {
        console.warn('[webhook] Invalid signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const event = JSON.parse(req.body.toString());

    if (event.event_type === 'transaction.completed') {
      const txn      = event.data;
      const priceId  = txn?.custom_data?.priceId || txn?.items?.[0]?.price?.id;
      const pack     = PACKS[priceId];

      if (!pack) {
        console.warn('[webhook] Unknown priceId:', priceId);
        return res.json({ ok: true }); // ack to Paddle anyway
      }

      // Generate a unique license key
      const licenseKey = generateLicenseKey();
      const email      = txn?.customer?.email || 'unknown';

      licenseStore.set(licenseKey, {
        credits:   pack.credits,
        label:     pack.label,
        priceId,
        email,
        usedAt:    null,
        createdAt: Date.now(),
        txnId:     txn.id,
      });

      console.log(`[webhook] License generated: ${licenseKey} (${pack.label}) for ${email}`);

      // TODO: email the license key to the customer
      // Use Resend / Postmark / SendGrid free tier — see README
    }

    res.json({ ok: true });

  } catch (err) {
    console.error('[webhook]', err.message);
    res.status(500).json({ error: 'Webhook error' });
  }
});

// ──────────────────────────────────────────────────────────────
//  POST /api/verify-license
//  Body: { licenseKey: "MXXX-XXXX-XXXX-XXXX" }
//  Returns: { valid, credits, label }
// ──────────────────────────────────────────────────────────────
app.post('/api/verify-license', (req, res) => {
  try {
    const { licenseKey } = req.body;
    if (!licenseKey) return res.status(400).json({ valid: false, error: 'Missing key' });

    // Test keys for development
    if (licenseKey.startsWith('TEST-') && licenseKey.length >= 12) {
      return res.json({ valid: true, credits: 100, label: 'Test Pack' });
    }

    const record = licenseStore.get(licenseKey);
    if (!record) {
      return res.json({ valid: false, error: 'License key not found' });
    }
    if (record.usedAt) {
      return res.json({ valid: false, error: 'License key already activated' });
    }

    // Mark as used
    record.usedAt = Date.now();
    licenseStore.set(licenseKey, record);

    res.json({ valid: true, credits: record.credits, label: record.label });

  } catch (err) {
    res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────
//  GET /api/health
// ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, licenses: licenseStore.size });
});

// ── Helpers ───────────────────────────────────────────────────
function generateLicenseKey() {
  const seg = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `MLS-${seg()}-${seg()}-${seg()}`; // e.g. MLS-A1B2C3-D4E5F6-789ABC
}

app.listen(PORT, () => {
  console.log(`✅  Maps Lead Scraper API on port ${PORT}`);
  console.log(`    Paddle mode: ${process.env.PADDLE_ENV || 'sandbox'}`);
});

export default app;
