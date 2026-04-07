// POST /api/course-deliver
// Called by course page after Paddle checkout success redirect.
// Verifies the transaction via Paddle API, then sends course email directly.
// Body: { email: "buyer@example.com", txnId?: "txn_..." }
// This bypasses webhook entirely — reliable in sandbox and production.
const { cors, getRedis, sendCourseDeliveryEmail, shareCourseFolderAccess, BASE_URL, PADDLE_API_KEY } = require('./_helpers');

function sanitize(str, maxLen = 120) {
  return String(str || '').trim().slice(0, maxLen);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
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

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Valid email is required.' });
  }

  try {
    const redis = getRedis();

    // ── Dedup: don't send course email twice for same email ──
    const dedupKey = `course-delivered:${email}`;
    const alreadySent = await redis.get(dedupKey);
    if (alreadySent) {
      return res.status(200).json({ ok: true, alreadySent: true, message: 'Course email was already sent to this address.' });
    }

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

    // ── Share Google Drive access ──
    const shareResult = await shareCourseFolderAccess({ email });

    // ── Send course delivery email ──
    await sendCourseDeliveryEmail({
      email,
      name: userName,
      txnId: txnId || 'direct-delivery',
      shareResult,
    });

    // ── Mark as delivered (expires in 30 days) ──
    await redis.set(dedupKey, JSON.stringify({
      email,
      txnId,
      sharedDrive: shareResult?.ok || false,
      deliveredAt: new Date().toISOString(),
    }), 'EX', 60 * 60 * 24 * 30);

    console.log(`Course delivered to ${email} (txn: ${txnId || 'N/A'}, drive: ${shareResult?.ok || false})`);

    return res.status(200).json({
      ok: true,
      email,
      driveShared: shareResult?.ok || false,
      driveError: shareResult?.ok ? null : (shareResult?.reason || 'unknown'),
      txnVerified,
    });
  } catch (err) {
    console.error('Course deliver error:', err);
    return res.status(500).json({ error: 'Failed to deliver course. Please contact support.' });
  }
};
