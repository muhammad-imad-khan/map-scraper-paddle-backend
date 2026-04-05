// POST /api/webhook
// Receives Paddle webhook notifications (e.g. transaction.completed).
// Auto-credits the user's account using installId from custom_data.
// Deduplicates by transaction ID so replay attacks are harmless.
const crypto = require('crypto');
const { cors, PRICE_CREDITS, addCredits, getRedis, keys, isValidInstallId, sendPurchaseNotification } = require('./_helpers');

// ── Webhook signature verification ─────────────────────
function verifySignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  try {
    const parts = {};
    signature.split(';').forEach(p => {
      const [k, v] = p.split('=');
      parts[k] = v;
    });
    const ts = parts.ts;
    const h1 = parts.h1;
    if (!ts || !h1) return false;

    const payload = `${ts}:${rawBody}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(h1), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Signature verification (skip if secret not set — sandbox testing) ──
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers['paddle-signature'] || '';
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!verifySignature(rawBody, sig, secret)) {
      console.warn('Webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const event = req.body;
  const eventType = event?.event_type;
  console.log(`Webhook received: ${eventType}`);

  // We only care about completed transactions
  if (eventType !== 'transaction.completed') {
    return res.status(200).json({ received: true, event: eventType });
  }

  try {
    const txnData = event?.data;
    const txnId = txnData?.id;
    const items = txnData?.items || [];
    const installId = txnData?.custom_data?.installId;

    // ── Deduplication: reject if we already processed this transaction ──
    const redis = getRedis();
    const alreadyProcessed = await redis.get(keys.txnDedup(txnId));
    if (alreadyProcessed) {
      console.log(`Duplicate webhook for txn ${txnId}, skipping`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // ── Validate installId from custom_data ──
    if (!isValidInstallId(installId)) {
      console.error(`Webhook missing installId in custom_data for txn: ${txnId}`);
      return res.status(200).json({ received: true, warning: 'No installId in custom_data' });
    }

    // ── Calculate credits to add ──
    let totalCredits = 0;
    let label = 'Credit Pack';

    for (const item of items) {
      const priceId = item?.price?.id;
      const match = PRICE_CREDITS[priceId];
      if (match) {
        totalCredits += match.credits * (item.quantity || 1);
        label = match.label;
      }
    }

    if (totalCredits === 0) {
      console.warn('No matching price IDs in txn:', txnId);
      return res.status(200).json({ received: true, warning: 'No matching prices' });
    }

    // ── Credit the user's account (atomic + set 7-day expiry) ──
    const result = await addCredits(installId, totalCredits, `purchase:${txnId}:${label}`);

    // ── Update user purchase status + send email notification ──
    const userEmail = txnData?.custom_data?.email;
    if (userEmail) {
      const userKey = `user:${userEmail}`;
      const userRaw = await redis.get(userKey);
      if (userRaw) {
        const userData = JSON.parse(userRaw);
        // Update matching pending purchase to 'completed'
        if (Array.isArray(userData.purchases)) {
          const pending = userData.purchases.find(p => p.txnId === txnId && p.status === 'pending');
          if (pending) {
            pending.status = 'completed';
            pending.completedAt = new Date().toISOString();
            pending.credits = totalCredits;
            pending.amount = txnData?.details?.totals?.total || null;
            pending.currency = txnData?.currency_code || null;
          } else {
            // No pending record (e.g. webhook arrived before checkout recorded it)
            userData.purchases = userData.purchases || [];
            userData.purchases.push({
              priceId: items[0]?.price?.id || null,
              installId,
              status: 'completed',
              createdAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              txnId,
              credits: totalCredits,
              label,
              amount: txnData?.details?.totals?.total || null,
              currency: txnData?.currency_code || null,
            });
          }
        }
        await redis.set(userKey, JSON.stringify(userData));

        // Send purchase notification email to admin
        sendPurchaseNotification({
          userName: userData.name,
          userEmail,
          packLabel: label,
          credits: totalCredits,
          amount: txnData?.details?.totals?.total ? (Number(txnData.details.totals.total) / 100).toFixed(2) : null,
          currency: txnData?.currency_code,
          txnId,
        }).catch(() => {}); // fire-and-forget, don't block webhook response
      }
    }

    // ── Mark transaction as processed (dedup key, expires in 30 days) ──
    await redis.set(keys.txnDedup(txnId), JSON.stringify({
      installId,
      credits: totalCredits,
      processedAt: new Date().toISOString(),
    }), 'EX', 60 * 60 * 24 * 30);

    console.log(`Auto-credited ${totalCredits} credits to ${installId} (txn: ${txnId}). Balance: ${result.newBalance}, expires: ${new Date(result.expiresAt).toISOString()}`);

    return res.status(200).json({
      received: true,
      credited: totalCredits,
      newBalance: result.newBalance,
      expiresAt: result.expiresAt,
      installId,
    });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).json({ error: 'Internal processing error' });
  }
};
