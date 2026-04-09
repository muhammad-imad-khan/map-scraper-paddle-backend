# Maps Lead Scraper — Paddle Payment Backend

## Why Paddle?
- ✅ Supports **Pakistan as a seller country**
- ✅ Payouts via **SWIFT bank transfer** (works with Pakistani banks) or **Payoneer**
- ✅ Merchant of Record — Paddle handles global VAT/GST, not you
- ✅ No Stripe required
- ✅ Free to start — Paddle takes ~5% per transaction

---

## Step 1 — Create Paddle Account

1. Go to **paddle.com** → Sign Up
2. Select **"I sell digital products"**
3. When asked for country: **Pakistan**
4. Payout method: **Payoneer** (recommended) or bank wire (SWIFT)

> ⚠️ Paddle may ask for identity verification. Have your CNIC and bank details ready.

---

## Step 2 — Create Products in Paddle Dashboard

Go to **Catalog → Products → New Product** and create 3 products:

| Product Name                          | Price | Type    |
|---------------------------------------|-------|---------|
| Maps Lead Scraper — 100 Credits       | $5    | One-time|
| Maps Lead Scraper — 500 Credits       | $19   | One-time|
| Maps Lead Scraper — 1000 Credits      | $35   | One-time|

After creating each product, go to **Prices** tab and copy the **Price ID** (starts with `pri_`).

Open `server.js` and replace the PACKS keys:
```js
const PACKS = {
  'pri_ACTUAL_100_ID':  { credits: 100,  price: '$5',  label: 'Starter Pack' },
  'pri_ACTUAL_500_ID':  { credits: 500,  price: '$19', label: 'Pro Pack'     },
  'pri_ACTUAL_1000_ID': { credits: 1000, price: '$35', label: 'Agency Pack'  },
};
```

Also update `background.js` in the extension with the same Price IDs.

---

## Step 3 — Get API Key

Paddle Dashboard → **Developer → Authentication → Generate API Key**

Copy the key, add to `.env`:
```
PADDLE_API_KEY=your_key_here
```

For sandbox (testing): use the **Sandbox** environment toggle at the top of the dashboard.

---

## Step 4 — Deploy Backend (Vercel — free)

```bash
cd paddle-backend
npm install
npx vercel deploy
```

Set these environment variables in Vercel dashboard:
```
PADDLE_API_KEY        → your Paddle API key
PADDLE_WEBHOOK_SECRET → set after Step 5
PAYMENT_CHECKOUT_URL  → https://buy.paddle.com/...
SUCCESS_URL           → https://mapsleadscraper.com/success
SITE_ORIGIN           → https://mapsleadscraper.com
```

`PAYMENT_CHECKOUT_URL` is used by the website payment page via `/api/payment-config`, so the frontend can keep the checkout destination in server-side environment config instead of hardcoding it into static HTML.

Your API will be at: `https://your-project.vercel.app`

---

## Step 5 — Set Up Webhook

1. Paddle Dashboard → **Developer → Webhooks → New Webhook**
2. URL: `https://your-project.vercel.app/api/webhook`
3. Events: tick **`transaction.completed`**
4. Copy the **Secret Key** → add to Vercel env as `PADDLE_WEBHOOK_SECRET`

---

## Step 6 — Set Up Email Delivery (SMTP)

When a customer pays, your webhook generates a license key. Use SMTP credentials to email it.

1. Configure env vars:
   - `SMTP_HOST`
   - `SMTP_PORT`
   - `SMTP_USER`
   - `SMTP_PASS`
   - `SMTP_FROM` (optional, defaults to `SMTP_USER`)
2. Add to your webhook handler:

```js
const nodemailer = require('nodemailer');

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

await transport.sendMail({
  from: process.env.SMTP_FROM || process.env.SMTP_USER,
  to: email,
  subject: 'Your Maps Lead Scraper credits are ready',
  html: `<p>Hi ${name || 'there'},</p><p>Your license key: <strong>${licenseKey}</strong></p>`,
});
```

---

## Step 7 — Update Extension

In `background.js`, set your deployed backend URL:
```js
const BACKEND_URL = 'https://your-project.vercel.app';
```

And replace the CREDIT_PACKS price IDs with your actual Paddle Price IDs.

---

## Production Database (optional but recommended)

The current server uses in-memory storage — keys are lost on restart.

**Supabase (free tier)** — 500MB database, works great:
```bash
npm install @supabase/supabase-js
```

Replace `licenseStore` Map with a Supabase table.

---

## Testing

Use Paddle's test card: `4000 0000 0000 0002` (any future expiry, any CVV)

Test license key prefix for dev: `TEST-XXXX-XXXX` (server accepts these without DB lookup)
