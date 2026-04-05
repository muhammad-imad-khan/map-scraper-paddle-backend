// ── Shared Paddle helpers ────────────────────────────────
const Redis = require('ioredis');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const PADDLE_ENV = (process.env.PADDLE_ENV || 'sandbox').trim();

const BASE_URL = (PADDLE_ENV === 'live' || PADDLE_ENV === 'production')
  ? 'https://api.paddle.com'
  : 'https://sandbox-api.paddle.com';

const PADDLE_API_KEY = (process.env.PADDLE_API_KEY || '').trim();

const FREE_STARTER_CREDITS = 3;
const CREDITS_EXPIRY_DAYS = 7;

// Two paid tiers — maps priceId → credits + label
const PRICE_CREDITS = {
  [process.env.PRICE_PRO || 'pri_01kkwtx0kh2skzrzjbxgmgqngd']:        { credits: 500,  label: 'Pro Pack' },
  [process.env.PRICE_ENTERPRISE || 'pri_01kkwtyfwvrwspy654f56h4n5d']:       { credits: 2500, label: 'Enterprise Pack' },
  [process.env.PRICE_ONE_TIME_ID || 'pri_01knfqkcbhqbnwhq5k1ace3sd9']:      { credits: 0, label: 'Lifetime License', unlimited: true },
  [process.env.PRICE_ONE_TIME_INTL_ID || 'pri_01knfsscfv6njhwwb40k8p6mwz']: { credits: 0, label: 'Lifetime License', unlimited: true },
};

// ── Redis singleton ───────────────────────────────────────
let _redis;
function getRedis() {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      tls: process.env.REDIS_URL?.startsWith('rediss://') ? {} : undefined,
    });
    _redis.connect().catch(() => {});
  }
  return _redis;
}

// ── Key helpers (RLS: each user scoped by installId) ──────
const keys = {
  credits:   (id) => `credits:${id}`,
  expiry:    (id) => `expiry:${id}`,
  txnLog:    (id) => `txnlog:${id}`,
  txnDedup:  (txnId) => `txn:${txnId}`,
  install:   (id) => `install:${id}`,
  stats:     (name) => `stats:${name}`,
};

// ── Credit operations (all server-side, atomic) ───────────
async function getCredits(installId) {
  const redis = getRedis();
  // Check expiry first — if expired, wipe credits
  const expiry = await redis.get(keys.expiry(installId));
  if (expiry && Date.now() > parseInt(expiry, 10)) {
    await redis.set(keys.credits(installId), 0);
    await redis.del(keys.expiry(installId));
    return { credits: 0, expired: true, expiresAt: null };
  }
  const val = await redis.get(keys.credits(installId));
  return {
    credits: val !== null ? parseInt(val, 10) : null,
    expired: false,
    expiresAt: expiry ? parseInt(expiry, 10) : null,
  };
}

async function initUser(installId) {
  const redis = getRedis();
  const existing = await redis.get(keys.credits(installId));
  if (existing !== null) {
    // Check expiry
    const expiry = await redis.get(keys.expiry(installId));
    if (expiry && Date.now() > parseInt(expiry, 10)) {
      await redis.set(keys.credits(installId), 0);
      await redis.del(keys.expiry(installId));
      return { credits: 0, expired: true, expiresAt: null, isNew: false };
    }
    return {
      credits: parseInt(existing, 10),
      expired: false,
      expiresAt: expiry ? parseInt(expiry, 10) : null,
      isNew: false,
    };
  }
  // New user: grant starter credits (no expiry on free credits)
  await redis.set(keys.credits(installId), FREE_STARTER_CREDITS);
  await redis.set(keys.install(installId), JSON.stringify({
    createdAt: new Date().toISOString(),
  }));
  await redis.incr(keys.stats('total_installs'));
  return { credits: FREE_STARTER_CREDITS, expired: false, expiresAt: null, isNew: true };
}

async function addCredits(installId, amount, reason) {
  const redis = getRedis();
  const newBal = await redis.incrby(keys.credits(installId), amount);
  // Set 7-day expiry from now (resets on each purchase)
  const expiresAt = Date.now() + CREDITS_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  await redis.set(keys.expiry(installId), expiresAt);
  await redis.rpush(keys.txnLog(installId), JSON.stringify({
    type: 'credit', amount, reason, balance: newBal, expiresAt, at: new Date().toISOString(),
  }));
  return { newBalance: newBal, expiresAt };
}

async function deductCredits(installId, amount) {
  const redis = getRedis();
  // Lua script for atomic deduct-if-sufficient
  const lua = `
    local cur = tonumber(redis.call('get', KEYS[1]) or 0)
    local cost = tonumber(ARGV[1])
    if cur >= cost then
      redis.call('decrby', KEYS[1], cost)
      return cur - cost
    else
      return -1
    end
  `;
  const result = await redis.eval(lua, 1, keys.credits(installId), amount);
  return parseInt(result, 10);
}

// ── Validate installId format ─────────────────────────────
function isValidInstallId(id) {
  return typeof id === 'string' && id.length >= 8 && id.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(id);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Install-Id, X-Admin-Key, Authorization');
}

async function paddleRequest(path, body) {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// ── Email notifications ───────────────────────────────────
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'elysiansoft.systems@gmail.com';

function getMailTransport() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

async function sendPurchaseNotification({ userName, userEmail, packLabel, credits, amount, currency, txnId }) {
  const transport = getMailTransport();
  if (!transport) {
    console.warn('SMTP not configured, skipping purchase notification email');
    return;
  }
  const date = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' });
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:#1e40af;padding:20px 24px;color:#fff;">
        <h2 style="margin:0;font-size:20px;">New Purchase</h2>
      </div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px 0;color:#64748b;width:130px;">Customer</td><td style="padding:8px 0;font-weight:600;">${userName || 'N/A'}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Email</td><td style="padding:8px 0;">${userEmail || 'N/A'}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Pack</td><td style="padding:8px 0;font-weight:600;">${packLabel}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Credits</td><td style="padding:8px 0;">${credits.toLocaleString()}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Amount</td><td style="padding:8px 0;font-weight:600;">${currency ? currency.toUpperCase() + ' ' : '$'}${amount || 'N/A'}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Transaction ID</td><td style="padding:8px 0;font-size:12px;">${txnId}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Date (UTC)</td><td style="padding:8px 0;">${date}</td></tr>
        </table>
      </div>
      <div style="background:#f8fafc;padding:14px 24px;font-size:12px;color:#94a3b8;text-align:center;">
        Map Lead Scraper &mdash; Automated Purchase Notification
      </div>
    </div>
  `;
  try {
    await transport.sendMail({
      from: `"Map Lead Scraper" <${process.env.SMTP_USER}>`,
      to: ADMIN_EMAIL,
      subject: `New Purchase: ${packLabel} by ${userEmail || 'Unknown'}`,
      html,
    });
    console.log(`Purchase notification sent for txn ${txnId}`);
  } catch (err) {
    console.error('Failed to send purchase notification:', err.message);
  }
}

async function sendInstallNotification({ installId }) {
  const transport = getMailTransport();
  if (!transport) {
    console.warn('SMTP not configured, skipping install notification email');
    return;
  }
  const date = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' });
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:#7c3aed;padding:20px 24px;color:#fff;">
        <h2 style="margin:0;font-size:20px;">New Free Installation</h2>
      </div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px 0;color:#64748b;width:130px;">Install ID</td><td style="padding:8px 0;font-size:12px;">${installId}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Free Credits</td><td style="padding:8px 0;font-weight:600;">${FREE_STARTER_CREDITS}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Date (UTC)</td><td style="padding:8px 0;">${date}</td></tr>
        </table>
      </div>
      <div style="background:#f8fafc;padding:14px 24px;font-size:12px;color:#94a3b8;text-align:center;">
        Map Lead Scraper &mdash; New Install Notification
      </div>
    </div>
  `;
  try {
    await transport.sendMail({
      from: `"Map Lead Scraper" <${process.env.SMTP_USER}>`,
      to: ADMIN_EMAIL,
      subject: `New Free Install: ${installId.slice(0, 8)}...`,
      html,
    });
    console.log(`Install notification sent for ${installId}`);
  } catch (err) {
    console.error('Failed to send install notification:', err.message);
  }
}

const LOW_CREDITS_THRESHOLD = 5;

async function sendLowCreditsEmail({ email, name, credits, installId }) {
  const transport = getMailTransport();
  if (!transport || !email) return;
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:#d97706;padding:20px 24px;color:#fff;">
        <h2 style="margin:0;font-size:20px;">Your Credits Are Running Low</h2>
      </div>
      <div style="padding:24px;">
        <p style="font-size:14px;color:#334155;margin:0 0 16px;">Hi${name ? ' ' + name : ''},</p>
        <p style="font-size:14px;color:#334155;margin:0 0 16px;">You only have <strong style="color:#d97706;font-size:18px;">${credits}</strong> credit${credits !== 1 ? 's' : ''} remaining. Each scrape uses 1 credit.</p>
        <p style="font-size:14px;color:#334155;margin:0 0 20px;">Top up now so your scraping isn't interrupted:</p>
        <div style="text-align:center;margin-bottom:20px;">
          <a href="https://map-scrapper-five.vercel.app/payment/" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Buy More Credits</a>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr><td style="padding:6px 0;color:#64748b;">Pro Pack</td><td style="padding:6px 0;font-weight:600;">500 credits — $5</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Enterprise Pack</td><td style="padding:6px 0;font-weight:600;">2,500 credits — $25</td></tr>
        </table>
      </div>
      <div style="background:#f8fafc;padding:14px 24px;font-size:12px;color:#94a3b8;text-align:center;">
        Map Lead Scraper &mdash; Low Credits Alert
      </div>
    </div>
  `;
  try {
    await transport.sendMail({
      from: `"Map Lead Scraper" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Only ${credits} credit${credits !== 1 ? 's' : ''} left — top up now`,
      html,
    });
    console.log(`Low credits email sent to ${email} (${credits} remaining)`);
  } catch (err) {
    console.error('Failed to send low credits email:', err.message);
  }
}

module.exports = {
  PADDLE_ENV, BASE_URL, PADDLE_API_KEY, PRICE_CREDITS, FREE_STARTER_CREDITS, CREDITS_EXPIRY_DAYS,
  LOW_CREDITS_THRESHOLD,
  cors, paddleRequest, getRedis, keys,
  getCredits, initUser, addCredits, deductCredits, isValidInstallId,
  sendPurchaseNotification, sendInstallNotification, sendLowCreditsEmail, ADMIN_EMAIL,
};

