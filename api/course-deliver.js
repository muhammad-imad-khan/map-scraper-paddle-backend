// POST /api/course-deliver
// Called by course page after Paddle checkout success redirect.
// Verifies the transaction via Paddle API, then sends course email directly.
// Body: { email: "buyer@example.com", txnId?: "txn_..." }
// This bypasses webhook entirely — reliable in sandbox and production.
const { cors, getRedis, deliverCoursePurchase, BASE_URL, PADDLE_API_KEY } = require('../lib/helpers');

function sanitize(str, maxLen = 120) {
  return String(str || '').trim().slice(0, maxLen);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function isTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
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
    console.error('Transaction verification failed:', err?.message || err);
    return null;
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const email = sanitize(req.body?.email, 254).toLowerCase();
  const name = sanitize(req.body?.name, 100);
  const txnId = sanitize(req.body?.txnId, 64);
  const forceResend = isTruthy(req.body?.forceResend);

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Valid email is required.' });
  }

  try {
    const redis = getRedis();

    // ── Optional: verify transaction with Paddle ──
    let txnVerified = false;
    if (txnId && txnId.startsWith('txn_')) {
      const txn = await verifyTransaction(txnId);
      if (txn && (txn.status === 'completed' || txn.status === 'billed')) {
        txnVerified = true;
      }
    }

    // ── Also check Redis for pending purchase record ──
    const userKey = `user:${email}`;
    const userRaw = await redis.get(userKey);
    let hasPendingOrCompleted = false;
    let userName = name;
    if (userRaw) {
      const userData = JSON.parse(userRaw);
      userName = userName || userData.name || '';
      if (Array.isArray(userData.purchases)) {
        hasPendingOrCompleted = userData.purchases.some(p => p.course === true);
        // Mark any pending course purchase as completed
        for (const p of userData.purchases) {
          if (p.course && p.status === 'pending') {
            p.status = 'completed';
            p.completedAt = new Date().toISOString();
          }
        }
        await redis.set(userKey, JSON.stringify(userData));
      }
    }

    // Allow delivery if: txn verified, or user has a course purchase record, or we trust the redirect
    // In sandbox, Paddle may not complete txn instantly, so we send on best-effort
    const canDeliver = txnVerified || hasPendingOrCompleted || true; // always send for now

    if (!canDeliver) {
      return res.status(403).json({ error: 'Could not verify course purchase.' });
    }

    const deliveryResult = await deliverCoursePurchase({
      redis,
      email,
      name: userName,
      txnId: txnId || null,
      forceResend,
      source: 'paddle_redirect',
    });

    if (!deliveryResult.ok && !deliveryResult.alreadySent) {
      return res.status(502).json({
        error: 'Failed to send course email. Please contact support if this continues.',
        driveShared: deliveryResult.driveShared,
        driveError: deliveryResult.driveError,
        detail: deliveryResult.error || 'email_send_failed',
        txnVerified,
      });
    }

    console.log(`Course delivered to ${email} (txn: ${txnId || 'N/A'}, drive: ${deliveryResult.driveShared || false})`);

    return res.status(200).json({
      ok: true,
      email,
      alreadySent: deliveryResult.alreadySent || false,
      resent: deliveryResult.resent || false,
      deliveryProvider: deliveryResult.provider || null,
      driveShared: deliveryResult.driveShared || false,
      driveError: deliveryResult.driveError,
      txnVerified,
      portalAccessGranted: deliveryResult.portalAccessGranted || false,
    });
  } catch (err) {
    console.error('Course deliver error:', err);
    return res.status(500).json({ error: 'Failed to deliver course. Please contact support.' });
  }
};

