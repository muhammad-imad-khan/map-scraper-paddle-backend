// ── Shared Paddle helpers ────────────────────────────────
const Redis = require('ioredis');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

let google;
try {
  ({ google } = require('googleapis'));
} catch {
  google = null;
}

function sanitizeText(value, maxLen = 200) {
  return String(value || '').trim().slice(0, maxLen);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function slugify(value) {
  return sanitizeText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeParse(json, fallback = null) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 100000, 64, 'sha512', (err, derived) => {
      if (err) reject(err);
      else resolve(derived.toString('hex'));
    });
  });
}

function toBool(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readModeEnv(baseName, fallback = '') {
  const modePrimary = IS_PRODUCTION ? `${baseName}_PRODUCTION` : `${baseName}_DEVELOPMENT`;
  const modeAlias = IS_PRODUCTION ? `${baseName}_PROD` : `${baseName}_DEV`;
  const raw = process.env[modePrimary] ?? process.env[modeAlias] ?? process.env[baseName] ?? fallback;
  return String(raw || '').trim();
}

const IS_PRODUCTION = toBool(process.env.IS_PRODUCTION ?? process.env.PRODUCTION);

const DEFAULT_PRICE_IDS = {
  pro: 'pri_01kkwtx0kh2skzrzjbxgmgqngd',
  enterprise: 'pri_01kkwtyfwvrwspy654f56h4n5d',
  oneTimePk: 'pri_01knfqkcbhqbnwhq5k1ace3sd9',
  oneTimeIntl: 'pri_01knfsscfv6njhwwb40k8p6mwz',
  course: 'pri_01knmdy54t0wd91ne4tspntxty',
};

const PRICE_IDS = {
  pro: readModeEnv('PRICE_PRO', DEFAULT_PRICE_IDS.pro),
  enterprise: readModeEnv('PRICE_ENTERPRISE', DEFAULT_PRICE_IDS.enterprise),
  oneTimePk: readModeEnv('PRICE_ONE_TIME_ID', DEFAULT_PRICE_IDS.oneTimePk),
  oneTimeIntl: readModeEnv('PRICE_ONE_TIME_INTL_ID', DEFAULT_PRICE_IDS.oneTimeIntl),
  course: readModeEnv('PRICE_COURSE_ID', DEFAULT_PRICE_IDS.course),
  courseIntl: readModeEnv('PRICE_COURSE_INTL_ID', readModeEnv('PRICE_COURSE_ID', DEFAULT_PRICE_IDS.course)),
  checkoutFallback: readModeEnv('PRICE_CHECKOUT_FALLBACK_ID', ''),
};

const FRONTEND_URL = readModeEnv('FRONTEND_URL', 'https://map-scrapper-five.vercel.app');
const SITE_ORIGIN = readModeEnv('SITE_ORIGIN', FRONTEND_URL || 'https://map-scrapper-five.vercel.app');
const PAYMENT_PAGE_URL = `${(FRONTEND_URL || 'https://map-scrapper-five.vercel.app').replace(/\/$/, '')}/payment/`;

const PADDLE_ENV = readModeEnv('PADDLE_ENV', IS_PRODUCTION ? 'production' : 'sandbox').toLowerCase();
const PADDLE_WEBHOOK_SECRET = readModeEnv('PADDLE_WEBHOOK_SECRET', '');

const BASE_URL = (PADDLE_ENV === 'live' || PADDLE_ENV === 'production')
  ? 'https://api.paddle.com'
  : 'https://sandbox-api.paddle.com';

const PADDLE_API_KEY = readModeEnv('PADDLE_API_KEY', '');
const REDIS_URL = readModeEnv('REDIS_URL', process.env.REDIS_URL || '');

let _modeSummaryLogged = false;
function logModeSummaryOnce() {
  if (_modeSummaryLogged) return;
  _modeSummaryLogged = true;
  const modeLabel = IS_PRODUCTION ? 'production' : 'development';
  const paddleEnvLabel = PADDLE_ENV || '(unset)';
  const frontendHost = FRONTEND_URL || '(unset)';
  const hasPaddleKey = Boolean(PADDLE_API_KEY);
  const hasWebhookSecret = Boolean(PADDLE_WEBHOOK_SECRET);
  const hasRedis = Boolean(REDIS_URL);
  console.log(
    `[config] mode=${modeLabel} paddle_env=${paddleEnvLabel} frontend=${frontendHost} paddle_key=${hasPaddleKey ? 'set' : 'missing'} webhook_secret=${hasWebhookSecret ? 'set' : 'missing'} redis=${hasRedis ? 'set' : 'missing'}`
  );
}
logModeSummaryOnce();

const FREE_STARTER_CREDITS = 3;
const CREDITS_EXPIRY_DAYS = 7;

// Two paid tiers — maps priceId → credits + label
const PRICE_CREDITS = {
  [PRICE_IDS.pro]: { credits: 500, label: 'Pro Pack' },
  [PRICE_IDS.enterprise]: { credits: 2500, label: 'Enterprise Pack' },
  [PRICE_IDS.oneTimePk]: { credits: 0, label: 'Lifetime License', unlimited: true },
  [PRICE_IDS.oneTimeIntl]: { credits: 0, label: 'Lifetime License', unlimited: true },
  [PRICE_IDS.course]: { credits: 0, label: 'Lead Gen x AI Web Design Course', course: true },
  [PRICE_IDS.courseIntl]: { credits: 0, label: 'Lead Gen x AI Web Design Course', course: true },
};

// ── Redis singleton ───────────────────────────────────────
let _redis;
function getRedis() {
  if (!_redis) {
    _redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      tls: REDIS_URL?.startsWith('rediss://') ? {} : undefined,
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

const courseKeys = {
  index: () => 'courses:index',
  item: (courseId) => `course:${courseId}`,
  enrollment: (email, courseId) => `course-enrollment:${sanitizeText(email, 254).toLowerCase()}:${courseId}`,
  enrollmentListByCourse: (courseId) => `course-enrollments:${courseId}`,
  enrollmentListByUser: (email) => `user-course-enrollments:${sanitizeText(email, 254).toLowerCase()}`,
  progress: (email, courseId) => `course-progress:${sanitizeText(email, 254).toLowerCase()}:${courseId}`,
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
const ADMIN_EMAIL = readModeEnv('ADMIN_EMAIL', 'mapscrapper7@gmail.com');
const APP_BRAND = 'Lead Gen X Map Scrapper';
const APP_BRAND_PRO = 'Lead Gen X Map Scrapper Pro';

function isTruthy(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function getMailFrom(displayName = APP_BRAND) {
  const fromAddress = String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  if (!fromAddress) return null;
  return `"${displayName}" <${fromAddress}>`;
}

function normalizeSmtpPassword({ host, user, pass }) {
  const normalizedHost = String(host || '').trim().toLowerCase();
  const normalizedUser = String(user || '').trim().toLowerCase();
  const normalizedPass = String(pass || '');
  const isGmailSmtp = normalizedHost.includes('gmail.com') || normalizedUser.endsWith('@gmail.com');

  if (!isGmailSmtp) return normalizedPass;
  return normalizedPass.replace(/\s+/g, '');
}

async function sendTransactionalEmail({ from, to, subject, html, attachments }) {
  const transport = getMailTransport();
  if (!transport) {
    throw new Error('SMTP is not configured. Set SMTP_HOST/SMTP_PORT or SMTP_USER/SMTP_PASS.');
  }
  await transport.sendMail({ from, to, subject, html, attachments });
  return { provider: 'smtp' };
}

function getMailTransport() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = Number(process.env.SMTP_PORT || 0);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = normalizeSmtpPassword({
    host,
    user,
    pass: String(process.env.SMTP_PASS || '').trim(),
  });
  const hasAuth = Boolean(user && pass);

  if (host && Number.isFinite(port) && port > 0) {
    const secure = process.env.SMTP_SECURE
      ? isTruthy(process.env.SMTP_SECURE)
      : port === 465;
    const rejectUnauthorized = process.env.SMTP_TLS_REJECT_UNAUTHORIZED
      ? isTruthy(process.env.SMTP_TLS_REJECT_UNAUTHORIZED)
      : true;

    const transportConfig = {
      host,
      port,
      secure,
      tls: { rejectUnauthorized },
    };
    if (hasAuth) {
      transportConfig.auth = { user, pass };
    }
    return nodemailer.createTransport(transportConfig);
  }

  if (!hasAuth) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

async function sendPurchaseNotification({ userName, userEmail, packLabel, credits, amount, currency, txnId }) {
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
        ${APP_BRAND} &mdash; Automated Purchase Notification
      </div>
    </div>
  `;
  try {
    await sendTransactionalEmail({
      from: getMailFrom(APP_BRAND) || process.env.SMTP_USER,
      to: ADMIN_EMAIL,
      subject: `New Purchase: ${packLabel} by ${userEmail || 'Unknown'}`,
      html,
    });
    console.log(`Purchase notification sent for txn ${txnId}`);
  } catch (err) {
    console.error('Failed to send purchase notification:', err.message);
  }
}

async function sendZipDeliveryEmail({ email, name, txnId }) {
  if (!email) {
    console.warn('Recipient missing, skipping zip delivery email');
    return { ok: false, reason: 'recipient_missing' };
  }

  const zipPath = path.join(__dirname, '_assets', 'maps-scraper-extension-v1.0.zip');
  const hasZip = fs.existsSync(zipPath);
  const fallbackUrl = 'https://map-scrapper-five.vercel.app/#install';

  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:#16a34a;padding:20px 24px;color:#fff;">
        <h2 style="margin:0;font-size:20px;">Your Purchase Is Confirmed</h2>
      </div>
      <div style="padding:24px;">
        <p style="font-size:14px;color:#334155;margin:0 0 14px;">Hi${name ? ' ' + name : ''},</p>
        <p style="font-size:14px;color:#334155;margin:0 0 14px;">Thanks for purchasing ${APP_BRAND} lifetime access.</p>
        <p style="font-size:14px;color:#334155;margin:0 0 14px;">${hasZip ? 'Your extension ZIP is attached to this email.' : 'Your extension ZIP could not be attached automatically. Use the download button below.'}</p>
        <div style="text-align:center;margin:20px 0;">
          <a href="${fallbackUrl}" style="display:inline-block;background:#16a34a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Open Download Page</a>
        </div>
        <p style="font-size:12px;color:#64748b;margin:0;">Transaction ID: ${txnId || 'N/A'}</p>
      </div>
      <div style="background:#f8fafc;padding:14px 24px;font-size:12px;color:#94a3b8;text-align:center;">
        ${APP_BRAND} &mdash; Purchase Delivery Email
      </div>
    </div>
  `;

  try {
    const mail = {
      from: getMailFrom(APP_BRAND) || process.env.SMTP_USER,
      to: email,
      subject: `Your ${APP_BRAND} extension ZIP`,
      html,
    };
    if (hasZip) {
      mail.attachments = [{
        filename: 'maps-scraper-extension-v1.0.zip',
        path: zipPath,
        contentType: 'application/zip',
      }];
    }
    const result = await sendTransactionalEmail(mail);
    console.log(`Zip delivery email sent to ${email} (txn: ${txnId})`);
    return { ok: true, provider: result?.provider || 'smtp' };
  } catch (err) {
    console.error('Failed to send zip delivery email:', err.message);
    return { ok: false, reason: 'smtp_send_failed', message: err.message };
  }
}

async function sendInstallNotification({ installId }) {
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
        ${APP_BRAND} &mdash; New Install Notification
      </div>
    </div>
  `;
  try {
    await sendTransactionalEmail({
      from: getMailFrom(APP_BRAND) || process.env.SMTP_USER,
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
  if (!email) return;
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
          <a href="${PAYMENT_PAGE_URL}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Buy More Credits</a>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr><td style="padding:6px 0;color:#64748b;">Pro Pack</td><td style="padding:6px 0;font-weight:600;">500 credits — $5</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Enterprise Pack</td><td style="padding:6px 0;font-weight:600;">2,500 credits — $25</td></tr>
        </table>
      </div>
      <div style="background:#f8fafc;padding:14px 24px;font-size:12px;color:#94a3b8;text-align:center;">
        ${APP_BRAND} &mdash; Low Credits Alert
      </div>
    </div>
  `;
  try {
    await sendTransactionalEmail({
      from: getMailFrom(APP_BRAND) || process.env.SMTP_USER,
      to: email,
      subject: `Only ${credits} credit${credits !== 1 ? 's' : ''} left — top up now`,
      html,
    });
    console.log(`Low credits email sent to ${email} (${credits} remaining)`);
  } catch (err) {
    console.error('Failed to send low credits email:', err.message);
  }
}

// ── Course delivery + Google Drive sharing ───────────────
const COURSE_DRIVE_LINK = readModeEnv('COURSE_LINK', 'https://drive.google.com/drive/folders/1-FQQCwzAvlnHVKn2BYPhKBRB9lWVsaUi?usp=drive_link');
const COURSE_NAME = 'Lead Generation x AI Powered Web Design Course';
const TOOL_DELIVERY_TTL_SECONDS = 60 * 60 * 24 * 30;
const COURSE_DELIVERY_TTL_SECONDS = 60 * 60 * 24 * 30;

function getResendConfig() {
  return {
    apiKey: (process.env.RESEND_API_KEY || '').trim(),
    fromEmail: (process.env.RESEND_FROM_EMAIL || '').trim(),
  };
}

async function sendEmailWithResend({ to, subject, html }) {
  const { apiKey, fromEmail } = getResendConfig();
  if (!apiKey || !fromEmail || !to) {
    return { ok: false, reason: 'resend_not_configured' };
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject,
        html,
      }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        ok: false,
        reason: 'resend_send_failed',
        message: data?.message || data?.error?.message || data?.error || `HTTP ${resp.status}`,
      };
    }

    return {
      ok: true,
      provider: 'resend',
      messageId: data?.id || null,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'resend_send_failed',
      message: err?.message || 'Unknown Resend error',
    };
  }
}

function normalizePrivateKey(key) {
  return String(key || '').replace(/\\n/g, '\n').trim();
}

function getServiceAccountConfig() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      return {
        clientEmail: parsed.client_email,
        privateKey: normalizePrivateKey(parsed.private_key),
      };
    } catch (err) {
      console.error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON:', err.message);
    }
  }
  return {
    clientEmail: (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
    privateKey: normalizePrivateKey(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || ''),
  };
}

function extractDriveFolderId(link) {
  if (!link) return '';
  const fromFoldersPath = String(link).match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (fromFoldersPath && fromFoldersPath[1]) return fromFoldersPath[1];
  const fromQuery = String(link).match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (fromQuery && fromQuery[1]) return fromQuery[1];
  return '';
}

function getDriveClient() {
  if (!google) return null;
  const { clientEmail, privateKey } = getServiceAccountConfig();
  if (!clientEmail || !privateKey) return null;
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function shareCourseFolderAccess({ email }) {
  const folderId = extractDriveFolderId(COURSE_DRIVE_LINK);
  if (!email || !folderId) {
    return { ok: false, reason: 'missing_email_or_folder' };
  }

  const drive = getDriveClient();
  if (!drive) {
    return { ok: false, reason: 'google_credentials_missing' };
  }

  try {
    await drive.permissions.create({
      fileId: folderId,
      sendNotificationEmail: true,
      requestBody: {
        type: 'user',
        role: 'writer',
        emailAddress: email,
      },
      fields: 'id',
    });
    return { ok: true };
  } catch (err) {
    const message = err?.errors?.[0]?.message || err?.message || 'Google Drive share failed';
    if (/already\s+(?:has|exists)|duplicate|permission/i.test(message)) {
      return { ok: true, alreadyShared: true };
    }
    console.error(`Drive share failed for ${email}:`, message);
    return { ok: false, reason: 'api_error', message };
  }
}

async function sendCourseDeliveryEmail({ email, name, txnId, shareResult }) {
  if (!email) {
    console.warn('Recipient missing, skipping course delivery email');
    return { ok: false, reason: 'recipient_missing' };
  }
  if (!COURSE_DRIVE_LINK) {
    console.error('COURSE_LINK env variable not set, cannot deliver course');
    return { ok: false, reason: 'course_link_missing' };
  }

  const accessLine = shareResult?.ok
    ? 'Your Google Drive access has already been granted to this email as an editor.'
    : 'Your payment is confirmed. If the Drive invite does not appear in a few minutes, reply to this email and we will grant access manually.';

  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#a855f7,#6366f1);padding:24px;color:#fff;">
        <h2 style="margin:0;font-size:22px;">Payment Confirmed</h2>
        <p style="margin:8px 0 0;font-size:13px;opacity:.9;">${COURSE_NAME}</p>
      </div>
      <div style="padding:24px;">
        <p style="font-size:14px;color:#334155;margin:0 0 14px;">Hi${name ? ' ' + name : ''},</p>
        <p style="font-size:14px;color:#334155;margin:0 0 14px;">Thank you for your purchase. ${accessLine}</p>
        <div style="text-align:center;margin:24px 0;">
          <a href="${COURSE_DRIVE_LINK}" style="display:inline-block;background:linear-gradient(135deg,#a855f7,#6366f1);color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">Open Course Folder</a>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:16px;">
          <tr><td style="padding:6px 0;color:#64748b;width:120px;">Course</td><td style="padding:6px 0;font-weight:600;color:#334155;">${COURSE_NAME}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Transaction ID</td><td style="padding:6px 0;font-size:12px;color:#334155;">${txnId || 'N/A'}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Access</td><td style="padding:6px 0;color:#334155;">Google Drive Folder (Editor)</td></tr>
        </table>
      </div>
      <div style="background:#f8fafc;padding:14px 24px;font-size:12px;color:#94a3b8;text-align:center;">
        ${APP_BRAND} - Course Delivery
      </div>
    </div>
  `;

  const subject = 'Your Course Access Is Ready';

  const resendResult = await sendEmailWithResend({
    to: email,
    subject,
    html,
  });
  if (resendResult.ok) {
    console.log(`Course delivery email sent to ${email} via Resend (txn: ${txnId})`);
    return resendResult;
  }
  if (resendResult.reason !== 'resend_not_configured') {
    console.error('Resend course delivery failed:', resendResult.message || resendResult.reason);
  }

  const transport = getMailTransport();
  if (!transport) {
    console.warn('No email provider configured for course delivery');
    return {
      ok: false,
      reason: resendResult.reason === 'resend_not_configured' ? 'email_provider_not_configured' : 'resend_failed_and_smtp_missing',
      message: resendResult.message || resendResult.reason,
    };
  }

  try {
    await sendTransactionalEmail({
      from: getMailFrom('Imad Khan Courses') || process.env.SMTP_USER,
      to: email,
      subject,
      html,
    });
    console.log(`Course delivery email sent to ${email} via SMTP (txn: ${txnId})`);
    return { ok: true, provider: 'smtp' };
  } catch (err) {
    console.error('Failed to send course delivery email:', err.message);
    return { ok: false, reason: 'smtp_send_failed', message: err.message };
  }
}

async function sendSimpleCourseLinkEmail({ from = null, email, name }) {
  const recipient = sanitizeText(email, 254).toLowerCase();
  if (!isValidEmail(recipient)) {
    throw new Error('Valid email is required.');
  }
  if (!COURSE_DRIVE_LINK) {
    throw new Error('COURSE_LINK env variable not set.');
  }

  const safeName = sanitizeText(name || '', 100);
  const mailFrom = sanitizeText(from || '', 254) || getMailFrom('Imad Khan Courses') || process.env.SMTP_USER;
  if (!mailFrom) {
    throw new Error('SMTP_FROM or SMTP_USER is required.');
  }

  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:#0f172a;padding:20px 24px;color:#fff;">
        <h2 style="margin:0;font-size:20px;">Your Course Access</h2>
      </div>
      <div style="padding:24px;">
        <p style="font-size:14px;color:#334155;margin:0 0 14px;">Hi${safeName ? ' ' + safeName : ''},</p>
        <p style="font-size:14px;color:#334155;margin:0 0 14px;">Here is your course access link:</p>
        <div style="text-align:center;margin:22px 0;">
          <a href="${COURSE_DRIVE_LINK}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Open Course Link</a>
        </div>
        <p style="font-size:12px;color:#64748b;margin:0;word-break:break-all;">${COURSE_DRIVE_LINK}</p>
      </div>
      <div style="background:#f8fafc;padding:14px 24px;font-size:12px;color:#94a3b8;text-align:center;">
        ${APP_BRAND} - Course Access
      </div>
    </div>
  `;

  await sendTransactionalEmail({
    from: mailFrom,
    to: recipient,
    subject: 'Your Course Link',
    html,
  });
}

const DEFAULT_COURSE_ID = readModeEnv('DEFAULT_COURSE_ID', 'lead-gen-ai-web-design');
const CUSTOMER_PORTAL_URL = readModeEnv('CUSTOMER_PORTAL_URL', 'https://map-scrapper-five.vercel.app/portal/');

function normalizeCourseItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, itemIndex) => ({
    id: sanitizeText(item?.id || `item-${itemIndex + 1}`, 80) || `item-${itemIndex + 1}`,
    title: sanitizeText(item?.title || `Lesson ${itemIndex + 1}`, 160) || `Lesson ${itemIndex + 1}`,
    type: ['video', 'pdf', 'link', 'embed'].includes(item?.type) ? item.type : 'link',
    url: sanitizeText(item?.url || '', 2000),
    description: sanitizeText(item?.description || '', 400),
    durationMinutes: Number.isFinite(Number(item?.durationMinutes)) ? Number(item.durationMinutes) : null,
  }));
}

function normalizeCourseModules(modules) {
  if (!Array.isArray(modules)) return [];
  return modules.map((module, moduleIndex) => ({
    id: sanitizeText(module?.id || `module-${moduleIndex + 1}`, 80) || `module-${moduleIndex + 1}`,
    title: sanitizeText(module?.title || `Module ${moduleIndex + 1}`, 160) || `Module ${moduleIndex + 1}`,
    description: sanitizeText(module?.description || '', 400),
    items: normalizeCourseItems(module?.items),
  }));
}

function buildDefaultCourse() {
  return {
    id: DEFAULT_COURSE_ID,
    slug: DEFAULT_COURSE_ID,
    title: 'Lead Gen x AI Powered Web Design',
    shortDescription: 'Sell websites using scraped leads, AI workflows, and a repeatable client-close system.',
    description: 'Core course workspace for videos, PDFs, prompts, and delivery assets.',
    status: 'published',
    priceId: PRICE_IDS.course,
    coverImage: '',
    modules: [
      {
        id: 'starter-resources',
        title: 'Starter Resources',
        description: 'Primary course access and handoff resources.',
        items: [
          {
            id: 'drive-folder',
            title: 'Course Resource Folder',
            type: 'link',
            url: COURSE_DRIVE_LINK,
            description: 'Main course folder with the latest videos, PDFs, and templates.',
            durationMinutes: null,
          },
        ],
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function listIndexValues(redis, key) {
  const values = await redis.lrange(key, 0, -1);
  return Array.from(new Set(values.filter(Boolean)));
}

async function ensureIndexed(redis, listKey, value) {
  if (!value) return;
  const items = await listIndexValues(redis, listKey);
  if (!items.includes(value)) {
    await redis.rpush(listKey, value);
  }
}

async function ensureDefaultCourse(redis = getRedis()) {
  const existing = await redis.get(courseKeys.item(DEFAULT_COURSE_ID));
  if (existing) {
    await ensureIndexed(redis, courseKeys.index(), DEFAULT_COURSE_ID);
    return safeParse(existing, buildDefaultCourse());
  }
  const course = buildDefaultCourse();
  await redis.set(courseKeys.item(course.id), JSON.stringify(course));
  await ensureIndexed(redis, courseKeys.index(), course.id);
  return course;
}

async function getCourse(courseId, redis = getRedis()) {
  await ensureDefaultCourse(redis);
  const normalizedId = sanitizeText(courseId || DEFAULT_COURSE_ID, 120) || DEFAULT_COURSE_ID;
  const raw = await redis.get(courseKeys.item(normalizedId));
  return safeParse(raw, null);
}

async function listCourses(redis = getRedis()) {
  await ensureDefaultCourse(redis);
  const ids = await listIndexValues(redis, courseKeys.index());
  if (!ids.length) return [];
  const pipe = redis.pipeline();
  ids.forEach((id) => pipe.get(courseKeys.item(id)));
  const results = await pipe.exec();
  return results
    .map((entry) => safeParse(entry && entry[1], null))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

async function saveCourse(input, redis = getRedis()) {
  await ensureDefaultCourse(redis);
  const now = new Date().toISOString();
  const draftId = sanitizeText(input?.id, 120);
  const draftSlug = slugify(input?.slug || input?.title || draftId || createId('course')) || createId('course');
  const courseId = draftId || draftSlug;
  const existing = await getCourse(courseId, redis);
  const course = {
    id: courseId,
    slug: draftSlug,
    title: sanitizeText(input?.title || existing?.title || 'Untitled Course', 160) || 'Untitled Course',
    shortDescription: sanitizeText(input?.shortDescription || existing?.shortDescription || '', 240),
    description: sanitizeText(input?.description || existing?.description || '', 4000),
    status: ['draft', 'published', 'archived'].includes(input?.status) ? input.status : (existing?.status || 'draft'),
    priceId: sanitizeText(input?.priceId || existing?.priceId || PRICE_IDS.course || '', 120),
    coverImage: sanitizeText(input?.coverImage || existing?.coverImage || '', 2000),
    modules: normalizeCourseModules(Array.isArray(input?.modules) ? input.modules : (existing?.modules || [])),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await redis.set(courseKeys.item(course.id), JSON.stringify(course));
  await ensureIndexed(redis, courseKeys.index(), course.id);
  return course;
}

async function deleteCourse(courseId, redis = getRedis()) {
  const normalizedId = sanitizeText(courseId, 120);
  if (!normalizedId || normalizedId === DEFAULT_COURSE_ID) {
    throw new Error('Default course cannot be deleted.');
  }
  await redis.del(courseKeys.item(normalizedId));
  await redis.lrem(courseKeys.index(), 0, normalizedId);
}

function defaultProgress() {
  return {
    completedItemIds: [],
    secondsByItem: {},
    percent: 0,
    lastItemId: null,
    lastSeenAt: null,
  };
}

function calculateCourseProgress(course, progress) {
  const totalItems = Array.isArray(course?.modules)
    ? course.modules.reduce((sum, module) => sum + (Array.isArray(module.items) ? module.items.length : 0), 0)
    : 0;
  if (!totalItems) return 0;
  const completed = Array.isArray(progress?.completedItemIds) ? progress.completedItemIds.length : 0;
  return Math.min(100, Math.round((completed / totalItems) * 100));
}

async function getEnrollment(email, courseId, redis = getRedis()) {
  const normalizedEmail = sanitizeText(email, 254).toLowerCase();
  const normalizedCourseId = sanitizeText(courseId || DEFAULT_COURSE_ID, 120) || DEFAULT_COURSE_ID;
  const raw = await redis.get(courseKeys.enrollment(normalizedEmail, normalizedCourseId));
  return safeParse(raw, null);
}

async function listEnrollments({ courseId, email } = {}, redis = getRedis()) {
  await ensureDefaultCourse(redis);
  const normalizedCourseId = sanitizeText(courseId || '', 120);
  const normalizedEmail = sanitizeText(email || '', 254).toLowerCase();

  let keysToLoad = [];
  if (normalizedCourseId) {
    const refs = await listIndexValues(redis, courseKeys.enrollmentListByCourse(normalizedCourseId));
    keysToLoad = refs.map((entryEmail) => courseKeys.enrollment(entryEmail, normalizedCourseId));
  } else if (normalizedEmail) {
    const refs = await listIndexValues(redis, courseKeys.enrollmentListByUser(normalizedEmail));
    keysToLoad = refs.map((entryCourseId) => courseKeys.enrollment(normalizedEmail, entryCourseId));
  } else {
    const found = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', 'course-enrollment:*', 'COUNT', 200);
      cursor = nextCursor;
      found.push(...batch);
    } while (cursor !== '0');
    keysToLoad = found;
  }

  if (!keysToLoad.length) return [];
  const pipe = redis.pipeline();
  keysToLoad.forEach((key) => pipe.get(key));
  const rows = await pipe.exec();

  const enrollments = [];
  for (const row of rows) {
    const enrollment = safeParse(row && row[1], null);
    if (!enrollment) continue;
    const course = await getCourse(enrollment.courseId, redis);
    const progressRaw = await redis.get(courseKeys.progress(enrollment.email, enrollment.courseId));
    const progress = safeParse(progressRaw, defaultProgress()) || defaultProgress();
    progress.percent = calculateCourseProgress(course, progress);
    enrollments.push({ ...enrollment, course, progress });
  }

  return enrollments.sort((a, b) => String(b.updatedAt || b.grantedAt || '').localeCompare(String(a.updatedAt || a.grantedAt || '')));
}

async function ensureUserForCourseAccess({ email, name }, redis = getRedis()) {
  const normalizedEmail = sanitizeText(email, 254).toLowerCase();
  const userKey = `user:${normalizedEmail}`;
  const existingRaw = await redis.get(userKey);
  if (existingRaw) {
    const user = safeParse(existingRaw, null);
    if (user) {
      user.name = sanitizeText(name || user.name || '', 100) || user.name || '';
      user.email = normalizedEmail;
      user.purchases = Array.isArray(user.purchases) ? user.purchases : [];
      await redis.set(userKey, JSON.stringify(user));
      return { user, createdAccount: false, temporaryPassword: null };
    }
  }

  const temporaryPassword = Math.random().toString(36).slice(2, 10) + 'A1!';
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = await hashPassword(temporaryPassword, salt);
  const user = {
    name: sanitizeText(name || normalizedEmail.split('@')[0], 100),
    email: normalizedEmail,
    passwordHash,
    salt,
    createdAt: new Date().toISOString(),
    purchases: [],
    portalAccessCreatedBySystem: true,
  };
  await redis.set(userKey, JSON.stringify(user));
  return { user, createdAccount: true, temporaryPassword };
}

async function sendPortalAccessEmail({ email, name, course, createdAccount, temporaryPassword, progressUrl }) {
  if (!email || !course) return;

  const loginLine = createdAccount
    ? `<p style="font-size:14px;color:#334155;margin:0 0 14px;">We created your portal account automatically.<br><strong>Email:</strong> ${email}<br><strong>Temporary password:</strong> ${temporaryPassword}</p>`
    : '<p style="font-size:14px;color:#334155;margin:0 0 14px;">Use your existing portal account to access the course. If you have not logged in before, use the same email address and reset/register from the customer portal.</p>';

  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#0f172a,#1d4ed8);padding:24px;color:#fff;">
        <h2 style="margin:0;font-size:22px;">Your Course Portal Access Is Ready</h2>
        <p style="margin:8px 0 0;font-size:13px;opacity:.9;">${sanitizeText(course.title, 160)}</p>
      </div>
      <div style="padding:24px;">
        <p style="font-size:14px;color:#334155;margin:0 0 14px;">Hi${name ? ' ' + sanitizeText(name, 100) : ''},</p>
        <p style="font-size:14px;color:#334155;margin:0 0 14px;">Your purchase has been activated. You can now open your customer portal, view your purchased course, watch lessons, open PDFs, and track your progress.</p>
        ${loginLine}
        <div style="text-align:center;margin:24px 0;">
          <a href="${progressUrl || CUSTOMER_PORTAL_URL}" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">Open Customer Portal</a>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:16px;">
          <tr><td style="padding:6px 0;color:#64748b;width:120px;">Course</td><td style="padding:6px 0;font-weight:600;color:#334155;">${sanitizeText(course.title, 160)}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Portal</td><td style="padding:6px 0;color:#334155;">${progressUrl || CUSTOMER_PORTAL_URL}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Status</td><td style="padding:6px 0;color:#334155;">Activated</td></tr>
        </table>
      </div>
      <div style="background:#f8fafc;padding:14px 24px;font-size:12px;color:#94a3b8;text-align:center;">
        ${APP_BRAND} - Customer Portal Access
      </div>
    </div>
  `;

  await sendTransactionalEmail({
    from: getMailFrom('Imad Khan Courses') || process.env.SMTP_USER,
    to: email,
    subject: `Portal Access: ${sanitizeText(course.title, 120)}`,
    html,
  });
}

async function grantCourseAccess({
  email,
  name,
  courseId,
  source = 'admin',
  txnId = null,
  bankTransferId = null,
  amount = null,
  currency = null,
  sendEmail = false,
  forceEmail = false,
} = {}, redis = getRedis()) {
  const normalizedEmail = sanitizeText(email, 254).toLowerCase();
  if (!isValidEmail(normalizedEmail)) {
    throw new Error('Valid email is required.');
  }

  const course = await getCourse(courseId || DEFAULT_COURSE_ID, redis);
  if (!course) {
    throw new Error('Course not found.');
  }

  const now = new Date().toISOString();
  const { user, createdAccount, temporaryPassword } = await ensureUserForCourseAccess({ email: normalizedEmail, name }, redis);
  const enrollmentKey = courseKeys.enrollment(normalizedEmail, course.id);
  const existingEnrollment = await getEnrollment(normalizedEmail, course.id, redis);
  const existingProgressRaw = await redis.get(courseKeys.progress(normalizedEmail, course.id));
  const progress = safeParse(existingProgressRaw, defaultProgress()) || defaultProgress();
  progress.percent = calculateCourseProgress(course, progress);

  const enrollment = {
    email: normalizedEmail,
    name: sanitizeText(name || user.name || '', 100),
    courseId: course.id,
    courseTitle: course.title,
    source,
    txnId: txnId || existingEnrollment?.txnId || null,
    bankTransferId: bankTransferId || existingEnrollment?.bankTransferId || null,
    status: 'active',
    grantedAt: existingEnrollment?.grantedAt || now,
    updatedAt: now,
    lastAccessEmailAt: existingEnrollment?.lastAccessEmailAt || null,
  };

  user.purchases = Array.isArray(user.purchases) ? user.purchases : [];
  const existingPurchase = user.purchases.find((purchase) => purchase.courseId === course.id || (purchase.course === true && purchase.label === course.title));
  if (existingPurchase) {
    existingPurchase.status = 'completed';
    existingPurchase.completedAt = now;
    existingPurchase.course = true;
    existingPurchase.courseId = course.id;
    existingPurchase.label = course.title;
    existingPurchase.priceId = course.priceId || existingPurchase.priceId || null;
    existingPurchase.txnId = txnId || existingPurchase.txnId || null;
    existingPurchase.amount = amount || existingPurchase.amount || null;
    existingPurchase.currency = currency || existingPurchase.currency || null;
    existingPurchase.source = source;
  } else {
    user.purchases.push({
      priceId: course.priceId || PRICE_IDS.course || null,
      installId: null,
      status: 'completed',
      createdAt: now,
      completedAt: now,
      txnId,
      label: course.title,
      course: true,
      courseId: course.id,
      amount,
      currency,
      source,
    });
  }

  await redis.set(`user:${normalizedEmail}`, JSON.stringify(user));
  await redis.set(enrollmentKey, JSON.stringify(enrollment));
  await ensureIndexed(redis, courseKeys.enrollmentListByCourse(course.id), normalizedEmail);
  await ensureIndexed(redis, courseKeys.enrollmentListByUser(normalizedEmail), course.id);
  await redis.set(courseKeys.progress(normalizedEmail, course.id), JSON.stringify(progress));

  if (sendEmail && (forceEmail || !existingEnrollment?.lastAccessEmailAt)) {
    await sendPortalAccessEmail({
      email: normalizedEmail,
      name: enrollment.name,
      course,
      createdAccount,
      temporaryPassword,
      progressUrl: `${CUSTOMER_PORTAL_URL}?course=${encodeURIComponent(course.id)}`,
    });
    enrollment.lastAccessEmailAt = now;
    await redis.set(enrollmentKey, JSON.stringify(enrollment));
  }

  return { enrollment, course, user, createdAccount, temporaryPassword, progress };
}

async function updateCourseProgress({ email, courseId, itemId, completed, secondsWatched = 0 } = {}, redis = getRedis()) {
  const normalizedEmail = sanitizeText(email, 254).toLowerCase();
  const normalizedCourseId = sanitizeText(courseId || DEFAULT_COURSE_ID, 120) || DEFAULT_COURSE_ID;
  const normalizedItemId = sanitizeText(itemId, 120);
  if (!normalizedEmail || !normalizedItemId) {
    throw new Error('email and itemId are required.');
  }

  const course = await getCourse(normalizedCourseId, redis);
  if (!course) throw new Error('Course not found.');

  const progressKey = courseKeys.progress(normalizedEmail, normalizedCourseId);
  const raw = await redis.get(progressKey);
  const progress = safeParse(raw, defaultProgress()) || defaultProgress();
  progress.completedItemIds = Array.isArray(progress.completedItemIds) ? progress.completedItemIds : [];
  progress.secondsByItem = progress.secondsByItem && typeof progress.secondsByItem === 'object' ? progress.secondsByItem : {};

  if (completed === true) {
    if (!progress.completedItemIds.includes(normalizedItemId)) {
      progress.completedItemIds.push(normalizedItemId);
    }
  } else if (completed === false) {
    progress.completedItemIds = progress.completedItemIds.filter((id) => id !== normalizedItemId);
  }

  if (Number.isFinite(Number(secondsWatched)) && Number(secondsWatched) > 0) {
    progress.secondsByItem[normalizedItemId] = Math.max(Number(progress.secondsByItem[normalizedItemId] || 0), Number(secondsWatched));
  }

  progress.lastItemId = normalizedItemId;
  progress.lastSeenAt = new Date().toISOString();
  progress.percent = calculateCourseProgress(course, progress);
  await redis.set(progressKey, JSON.stringify(progress));
  return progress;
}

async function deliverToolPurchase({
  redis = getRedis(),
  email,
  name,
  installId,
  txnId,
  forceResend = false,
  priceId = null,
  amount = null,
  currency = null,
  source = 'purchase',
} = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedInstallId = String(installId || '').trim();
  const normalizedTxnId = String(txnId || '').trim();
  const normalizedPriceId = String(priceId || '').trim();

  if (!isValidEmail(normalizedEmail)) {
    return { ok: false, entitlementGranted: false, reason: 'missing_email' };
  }

  if (!isValidInstallId(normalizedInstallId)) {
    return { ok: false, entitlementGranted: false, reason: 'missing_install_id' };
  }

  const deliveryKey = `tool-delivered:${normalizedTxnId || `${normalizedEmail}:${normalizedInstallId}`}`;
  const existingDeliveryRaw = await redis.get(deliveryKey);
  const existingDelivery = safeParse(existingDeliveryRaw, {}) || {};

  const userKey = `user:${normalizedEmail}`;
  const userRaw = await redis.get(userKey);
  const now = new Date().toISOString();
  const userData = safeParse(userRaw, {
    email: normalizedEmail,
    name: sanitizeText(name || '', 100),
    createdAt: now,
    purchases: [],
  }) || {
    email: normalizedEmail,
    name: sanitizeText(name || '', 100),
    createdAt: now,
    purchases: [],
  };

  userData.email = normalizedEmail;
  if (name) userData.name = sanitizeText(name, 100);
  userData.purchases = Array.isArray(userData.purchases) ? userData.purchases : [];

  let purchase = userData.purchases.find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (normalizedTxnId && String(entry.txnId || '').trim() === normalizedTxnId) return true;
    if (String(entry.installId || '').trim() !== normalizedInstallId) return false;
    const normalizedStatus = String(entry.status || '').toLowerCase();
    return normalizedStatus === 'pending' || normalizedStatus === 'completed';
  });

  const effectivePriceId = normalizedPriceId || String(purchase?.priceId || '').trim();
  const priceEntry = PRICE_CREDITS[effectivePriceId] || null;
  if (priceEntry?.course) {
    return { ok: false, entitlementGranted: false, reason: 'course_purchase_not_supported' };
  }

  const grantsUnlimited = Boolean(
    purchase?.unlimited === true
      || priceEntry?.unlimited === true
      || String(purchase?.label || '').toLowerCase().includes('lifetime')
  );
  const creditsToAdd = Number.isFinite(Number(purchase?.credits))
    ? Number(purchase.credits)
    : Number(priceEntry?.credits || 0);
  const label = sanitizeText(
    purchase?.label || priceEntry?.label || (grantsUnlimited ? 'Lifetime License' : 'Credit Pack'),
    120,
  ) || 'Credit Pack';

  if (!purchase && !effectivePriceId) {
    return { ok: false, entitlementGranted: false, reason: 'purchase_not_found' };
  }

  const wasCompleted = Boolean(purchase && String(purchase.status || '').toLowerCase() === 'completed');
  let creditResult = null;

  if (!purchase) {
    purchase = {
      priceId: effectivePriceId || null,
      installId: normalizedInstallId,
      status: 'completed',
      createdAt: now,
      completedAt: now,
      txnId: normalizedTxnId || null,
      credits: creditsToAdd,
      label,
      unlimited: grantsUnlimited,
      amount,
      currency,
      source,
    };
    userData.purchases.push(purchase);
    if (creditsToAdd > 0) {
      creditResult = await addCredits(normalizedInstallId, creditsToAdd, `purchase:${normalizedTxnId || 'tool'}:${label}`);
    }
  } else {
    purchase.priceId = effectivePriceId || purchase.priceId || null;
    purchase.installId = normalizedInstallId;
    purchase.label = label;
    purchase.unlimited = grantsUnlimited;
    purchase.credits = creditsToAdd;
    purchase.txnId = normalizedTxnId || purchase.txnId || null;
    purchase.amount = amount || purchase.amount || null;
    purchase.currency = currency || purchase.currency || null;
    purchase.source = source || purchase.source || 'purchase';

    if (!wasCompleted) {
      purchase.status = 'completed';
      purchase.completedAt = now;
      if (creditsToAdd > 0) {
        creditResult = await addCredits(normalizedInstallId, creditsToAdd, `purchase:${normalizedTxnId || 'tool'}:${label}`);
      }
    } else if (!purchase.completedAt) {
      purchase.completedAt = now;
    }
  }

  await redis.set(userKey, JSON.stringify(userData));

  if (normalizedTxnId) {
    await redis.set(keys.txnDedup(normalizedTxnId), JSON.stringify({
      installId: normalizedInstallId,
      credits: creditsToAdd,
      unlimited: grantsUnlimited,
      course: false,
      processedAt: now,
    }), 'EX', TOOL_DELIVERY_TTL_SECONDS);
  }

  if (!wasCompleted) {
    sendPurchaseNotification({
      userName: userData.name,
      userEmail: normalizedEmail,
      packLabel: label,
      credits: creditsToAdd,
      amount: amount !== null && amount !== undefined && amount !== ''
        ? (Number(amount) / 100).toFixed(2)
        : null,
      currency,
      txnId: normalizedTxnId || null,
    }).catch(() => {});
  }

  if (!grantsUnlimited) {
    return {
      ok: true,
      entitlementGranted: true,
      alreadySent: true,
      zipEmailSent: false,
      txnId: purchase.txnId || null,
      newBalance: creditResult?.newBalance || null,
      expiresAt: creditResult?.expiresAt || null,
    };
  }

  if (existingDeliveryRaw && !forceResend) {
    return {
      ok: true,
      entitlementGranted: true,
      alreadySent: true,
      zipEmailSent: true,
      txnId: purchase.txnId || null,
      provider: existingDelivery.deliveryProvider || null,
      newBalance: creditResult?.newBalance || null,
      expiresAt: creditResult?.expiresAt || null,
    };
  }

  const emailResult = await sendZipDeliveryEmail({
    email: normalizedEmail,
    name: userData.name,
    txnId: purchase.txnId || null,
  });

  if (!emailResult?.ok) {
    return {
      ok: false,
      entitlementGranted: true,
      alreadySent: false,
      zipEmailSent: false,
      txnId: purchase.txnId || null,
      error: emailResult?.message || emailResult?.reason || 'tool_email_failed',
      provider: emailResult?.provider || null,
      newBalance: creditResult?.newBalance || null,
      expiresAt: creditResult?.expiresAt || null,
    };
  }

  await redis.set(deliveryKey, JSON.stringify({
    email: normalizedEmail,
    installId: normalizedInstallId,
    txnId: purchase.txnId || null,
    deliveryProvider: emailResult.provider || null,
    deliveredAt: now,
  }), 'EX', TOOL_DELIVERY_TTL_SECONDS);

  return {
    ok: true,
    entitlementGranted: true,
    alreadySent: false,
    zipEmailSent: true,
    txnId: purchase.txnId || null,
    provider: emailResult.provider || null,
    newBalance: creditResult?.newBalance || null,
    expiresAt: creditResult?.expiresAt || null,
  };
}

async function deliverCoursePurchase({
  redis = getRedis(),
  email,
  name,
  txnId,
  forceResend = false,
  source = 'purchase',
  amount = null,
  currency = null,
  courseId = DEFAULT_COURSE_ID,
} = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    return { ok: false, reason: 'missing_email' };
  }

  const dedupKey = `course-delivered:${normalizedEmail}`;
  const existingRaw = await redis.get(dedupKey);
  let existing = {};
  if (existingRaw) {
    try {
      existing = JSON.parse(existingRaw) || {};
    } catch {
      existing = {};
    }
  }

  if (existingRaw && !forceResend) {
    return {
      ok: true,
      alreadySent: true,
      email: normalizedEmail,
      txnId: existing.txnId || txnId || null,
      driveShared: existing.sharedDrive || false,
      driveError: existing.driveError || null,
      provider: existing.deliveryProvider || null,
      portalAccessGranted: existing.portalAccessGranted || false,
    };
  }

  const shareResult = await shareCourseFolderAccess({ email: normalizedEmail });
  let portalResult;
  try {
    portalResult = await grantCourseAccess({
      email: normalizedEmail,
      name,
      courseId,
      source,
      txnId: txnId || null,
      amount,
      currency,
      sendEmail: false,
    }, redis);
  } catch (err) {
    return {
      ok: false,
      alreadySent: false,
      email: normalizedEmail,
      txnId: txnId || null,
      driveShared: shareResult?.ok || false,
      driveError: shareResult?.ok ? null : (shareResult?.message || shareResult?.reason || 'unknown'),
      error: err?.message || 'portal_access_failed',
      portalAccessGranted: false,
    };
  }

  const emailResult = await sendCourseDeliveryEmail({
    email: normalizedEmail,
    name,
    txnId,
    shareResult,
  });

  if (!emailResult?.ok) {
    return {
      ok: false,
      alreadySent: false,
      email: normalizedEmail,
      txnId: txnId || null,
      driveShared: shareResult?.ok || false,
      driveError: shareResult?.ok ? null : (shareResult?.message || shareResult?.reason || 'unknown'),
      error: emailResult?.message || emailResult?.reason || 'course_email_failed',
      portalAccessGranted: Boolean(portalResult?.enrollment),
    };
  }

  const deliveryRecord = {
    email: normalizedEmail,
    txnId: txnId || null,
    sharedDrive: shareResult?.ok || false,
    driveError: shareResult?.ok ? null : (shareResult?.message || shareResult?.reason || 'unknown'),
    deliveryProvider: emailResult.provider || null,
    portalAccessGranted: Boolean(portalResult?.enrollment),
    courseId: portalResult?.course?.id || courseId,
    deliveredAt: new Date().toISOString(),
  };

  await redis.set(dedupKey, JSON.stringify(deliveryRecord), 'EX', COURSE_DELIVERY_TTL_SECONDS);

  return {
    ok: true,
    alreadySent: false,
    resent: forceResend && Boolean(existingRaw),
    email: normalizedEmail,
    txnId: deliveryRecord.txnId,
    driveShared: deliveryRecord.sharedDrive,
    driveError: deliveryRecord.driveError,
    provider: deliveryRecord.deliveryProvider,
    portalAccessGranted: deliveryRecord.portalAccessGranted,
  };
}

module.exports = {
  IS_PRODUCTION, PADDLE_ENV, BASE_URL, PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET,
  PRICE_IDS, PRICE_CREDITS, FRONTEND_URL, SITE_ORIGIN,
  FREE_STARTER_CREDITS, CREDITS_EXPIRY_DAYS,
  LOW_CREDITS_THRESHOLD,
  cors, paddleRequest, getRedis, keys,
  getCredits, initUser, addCredits, deductCredits, isValidInstallId,
  normalizeSmtpPassword,
  sendPurchaseNotification, sendZipDeliveryEmail, sendCourseDeliveryEmail, shareCourseFolderAccess, deliverToolPurchase, deliverCoursePurchase,
  sendSimpleCourseLinkEmail,
  sendInstallNotification, sendLowCreditsEmail, ADMIN_EMAIL,
  DEFAULT_COURSE_ID, CUSTOMER_PORTAL_URL, courseKeys,
  sanitizeText, isValidEmail, slugify, safeParse,
  ensureDefaultCourse, listCourses, getCourse, saveCourse, deleteCourse,
  listEnrollments, getEnrollment, grantCourseAccess, updateCourseProgress,
  sendPortalAccessEmail,
};

