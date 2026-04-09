const {
  cors,
  getRedis,
  deliverToolPurchase,
  BASE_URL,
  PADDLE_API_KEY,
  PRICE_CREDITS,
  safeParse,
} = require('../lib/helpers');
const crypto = require('crypto');

const COURSE_PURCHASE_FLAGS = new Set(['course', 'courseintl']);

function sanitize(str, maxLen = 120) {
  return String(str || '').trim().slice(0, maxLen);
}

function normalizeClientId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (!/^[a-zA-Z0-9_-]{16,120}$/.test(normalized)) return '';
  return normalized;
}

function buildSessionFingerprint(req) {
  const userAgent = String(req?.headers?.['user-agent'] || '').trim();
  const language = String(req?.headers?.['accept-language'] || '').trim();
  const secChUa = String(req?.headers?.['sec-ch-ua'] || '').trim();
  const secChPlatform = String(req?.headers?.['sec-ch-ua-platform'] || '').trim();
  const raw = `${userAgent}|${language}|${secChUa}|${secChPlatform}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

async function getSessionUser(req, token, clientId, redis) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return null;
  const sessionRaw = await redis.get(`session:${normalizedToken}`);
  const session = safeParse(sessionRaw, null);
  if (!session || !session.email) return null;
  if (session.clientId && (!clientId || clientId !== session.clientId)) return null;
  if (session.fingerprint && buildSessionFingerprint(req) !== session.fingerprint) return null;
  const userRaw = await redis.get(`user:${String(session.email || '').toLowerCase()}`);
  return safeParse(userRaw, null);
}

function resolveMatchingPurchase(purchases, txnId, installId) {
  if (!Array.isArray(purchases)) return null;
  const normalizedTxnId = String(txnId || '').trim();
  const normalizedInstallId = String(installId || '').trim();
  return purchases.find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (normalizedTxnId && String(entry.txnId || '').trim() === normalizedTxnId) return true;
    if (!normalizedInstallId) return false;
    return String(entry.installId || '').trim() === normalizedInstallId;
  }) || null;
}

async function verifyTransaction(txnId) {
  if (!txnId || !PADDLE_API_KEY) return null;
  try {
    const resp = await fetch(`${BASE_URL}/transactions/${txnId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${PADDLE_API_KEY}`,
        Accept: 'application/json',
      },
    });
    const data = await resp.json().catch(() => ({}));
    return data?.data || null;
  } catch (err) {
    console.error('Tool transaction verification failed:', err?.message || err);
    return null;
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const txnId = sanitize(req.body?.txnId, 64);
  const requestedInstallId = sanitize(req.body?.installId, 80);
  const forceResend = req.body?.forceResend === true || req.body?.forceResend === 'true';
  const clientId = normalizeClientId(req.body?.clientId || req.headers['x-client-id']);
  const token = sanitize(req.body?.token, 128);

  try {
    const redis = getRedis();
    const user = await getSessionUser(req, token, clientId, redis);
    if (!user || !user.email) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    const purchases = Array.isArray(user.purchases) ? user.purchases : [];
    const matchedPurchase = resolveMatchingPurchase(purchases, txnId, requestedInstallId);
    const verifiedTxn = txnId && txnId.startsWith('txn_') ? await verifyTransaction(txnId) : null;
    const txnStatus = String(verifiedTxn?.status || '').toLowerCase();
    const txnVerified = txnStatus === 'completed' || txnStatus === 'billed';

    if (!txnVerified && !matchedPurchase) {
      return res.status(403).json({ error: 'Could not verify tool purchase yet.' });
    }

    const txnEmail = String(
      verifiedTxn?.custom_data?.email
        || verifiedTxn?.customer?.email
        || verifiedTxn?.customer_details?.email
        || verifiedTxn?.billing_details?.email
        || ''
    ).trim().toLowerCase();

    if (txnVerified && txnEmail && txnEmail !== String(user.email || '').trim().toLowerCase()) {
      return res.status(403).json({ error: 'This purchase belongs to a different account.' });
    }

    const verifiedPriceId = String(verifiedTxn?.items?.[0]?.price?.id || '').trim();
    const fallbackPriceId = String(matchedPurchase?.priceId || '').trim();
    const effectivePriceId = verifiedPriceId || fallbackPriceId;
    const purchaseMeta = PRICE_CREDITS[effectivePriceId] || null;

    if (purchaseMeta?.course || COURSE_PURCHASE_FLAGS.has(String(matchedPurchase?.pack || '').toLowerCase())) {
      return res.status(400).json({ error: 'Course purchases are handled by the course delivery flow.' });
    }

    const installId = String(
      requestedInstallId
        || verifiedTxn?.custom_data?.installId
        || matchedPurchase?.installId
        || ''
    ).trim();

    const result = await deliverToolPurchase({
      redis,
      email: user.email,
      name: user.name,
      installId,
      txnId: txnId || matchedPurchase?.txnId || null,
      forceResend,
      priceId: effectivePriceId,
      amount: verifiedTxn?.details?.totals?.total || matchedPurchase?.amount || null,
      currency: verifiedTxn?.currency_code || matchedPurchase?.currency || null,
      source: 'paddle_redirect',
    });

    if (!result.ok) {
      if (result.entitlementGranted) {
        return res.status(200).json({
          ok: true,
          txnId: txnId || matchedPurchase?.txnId || null,
          txnVerified,
          entitlementGranted: true,
          zipEmailSent: false,
          alreadySent: false,
          entitlements: {
            lifetimeAccess: true,
            zipDownload: true,
          },
          detail: result.error || result.reason || 'tool_email_failed',
          warning: 'Payment was confirmed and download is unlocked, but the ZIP email could not be sent.',
        });
      }

      return res.status(502).json({
        error: 'Failed to finalize tool purchase.',
        detail: result.error || result.reason || 'tool_delivery_failed',
        txnVerified,
      });
    }

    return res.status(200).json({
      ok: true,
      txnId: result.txnId || txnId || matchedPurchase?.txnId || null,
      txnVerified,
      entitlementGranted: true,
      zipEmailSent: result.zipEmailSent || false,
      alreadySent: result.alreadySent || false,
      deliveryProvider: result.provider || null,
      entitlements: {
        lifetimeAccess: true,
        zipDownload: true,
      },
    });
  } catch (err) {
    console.error('Tool deliver error:', err);
    return res.status(500).json({ error: 'Failed to finalize tool purchase.' });
  }
};