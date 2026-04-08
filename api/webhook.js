// POST /api/webhook
// Receives Paddle webhook notifications (e.g. transaction.completed).
// Auto-credits the user's account using installId from custom_data.
// Deduplicates by transaction ID so replay attacks are harmless.
const crypto = require('crypto');
const { cors, PRICE_CREDITS, addCredits, getRedis, keys, isValidInstallId, sendPurchaseNotification, sendZipDeliveryEmail, shareCourseFolderAccess, BASE_URL, PADDLE_API_KEY, grantCourseAccess, DEFAULT_COURSE_ID } = require('../lib/helpers');

const PADDLE_ENV = (process.env.PADDLE_ENV || 'sandbox').trim().toLowerCase();

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

async function fetchPaddleCustomerEmail(customerId) {
  if (!customerId || !PADDLE_API_KEY) return '';
  try {
    const resp = await fetch(`${BASE_URL}/customers/${customerId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${PADDLE_API_KEY}`,
        Accept: 'application/json',
      },
    });
    const data = await resp.json().catch(() => ({}));
    return (data?.data?.email || '').toString().trim().toLowerCase();
  } catch (err) {
    console.error('Customer email lookup failed:', err?.message || err);
    return '';
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Signature verification (skip if secret not set — sandbox testing) ──
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  const enforceSignature = Boolean(secret) && (PADDLE_ENV === 'live' || PADDLE_ENV === 'production' || process.env.WEBHOOK_STRICT_SIGNATURE === 'true');
  if (enforceSignature) {
    const sig = req.headers['paddle-signature'] || '';
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!verifySignature(rawBody, sig, secret)) {
      console.warn('Webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else if (secret && PADDLE_ENV === 'sandbox') {
    console.warn('Sandbox mode: skipping strict webhook signature check');
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

    // ── Calculate credits to add ──
    let totalCredits = 0;
    let label = 'Credit Pack';
    let matchedPurchase = false;
    let matchedPriceId = null;
    let grantsUnlimited = false;
    let isCoursePurchase = txnData?.custom_data?.coursePurchase === true || txnData?.custom_data?.coursePurchase === 'true';

    for (const item of items) {
      const priceId = item?.price?.id;
      const match = PRICE_CREDITS[priceId];
      if (match) {
        matchedPurchase = true;
        matchedPriceId = priceId;
        totalCredits += (match.credits || 0) * (item.quantity || 1);
        label = match.label;
        grantsUnlimited = grantsUnlimited || match.unlimited === true;
        isCoursePurchase = isCoursePurchase || match.course === true;
      }
    }

    if (!matchedPurchase && isCoursePurchase) {
      matchedPurchase = true;
      label = 'Lead Gen x AI Web Design Course';
      matchedPriceId = items[0]?.price?.id || null;
    }

    if (!matchedPurchase) {
      console.warn('No matching price IDs in txn:', txnId);
      return res.status(200).json({ received: true, warning: 'No matching prices' });
    }

    // Non-course purchases require installId for entitlements/credits.
    if (!isCoursePurchase && !isValidInstallId(installId)) {
      console.error(`Webhook missing installId in custom_data for txn: ${txnId}`);
      return res.status(200).json({ received: true, warning: 'No installId in custom_data' });
    }

    // ── Credit the user's account (atomic + set 7-day expiry) ──
    const result = (!isCoursePurchase && totalCredits > 0)
      ? await addCredits(installId, totalCredits, `purchase:${txnId}:${label}`)
      : null;

    // ── Update user purchase status + send email notification ──
    let resolvedEmailRaw = txnData?.custom_data?.email
      || txnData?.customer?.email
      || txnData?.customer_details?.email
      || txnData?.billing_details?.email
      || '';
    let userEmail = String(resolvedEmailRaw).trim().toLowerCase();

    if (!userEmail) {
      const customerId = txnData?.customer_id || txnData?.customer?.id;
      userEmail = await fetchPaddleCustomerEmail(customerId);
    }

    if (userEmail) {
      const userKey = `user:${userEmail}`;
      const userRaw = await redis.get(userKey);
      const userData = userRaw
        ? JSON.parse(userRaw)
        : {
            name: txnData?.custom_data?.name || txnData?.customer_details?.name || '',
            email: userEmail,
            createdAt: new Date().toISOString(),
            purchases: [],
          };

      userData.purchases = Array.isArray(userData.purchases) ? userData.purchases : [];
      const pending = userData.purchases.find(p => p.txnId === txnId && p.status === 'pending');
      if (pending) {
        pending.status = 'completed';
        pending.completedAt = new Date().toISOString();
        pending.credits = totalCredits;
        pending.amount = txnData?.details?.totals?.total || null;
        pending.currency = txnData?.currency_code || null;
        pending.label = label;
        pending.priceId = matchedPriceId || pending.priceId || null;
        pending.unlimited = grantsUnlimited;
        pending.course = isCoursePurchase;
      } else {
        // No pending record (e.g. webhook arrived before checkout wrote one)
        userData.purchases.push({
          priceId: matchedPriceId || items[0]?.price?.id || null,
          installId: isCoursePurchase ? null : installId,
          status: 'completed',
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          txnId,
          credits: totalCredits,
          label,
          unlimited: grantsUnlimited,
          course: isCoursePurchase,
          amount: txnData?.details?.totals?.total || null,
          currency: txnData?.currency_code || null,
        });
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

      if (grantsUnlimited) {
        sendZipDeliveryEmail({
          email: userEmail,
          name: userData.name,
          txnId,
        }).catch(() => {}); // fire-and-forget, don't block webhook response
      }

      if (isCoursePurchase) {
        shareCourseFolderAccess({ email: userEmail }).catch(() => ({}));
        grantCourseAccess({
          email: userEmail,
          name: userData.name,
          courseId: DEFAULT_COURSE_ID,
          source: 'paddle_webhook',
          txnId,
          amount: txnData?.details?.totals?.total || null,
          currency: txnData?.currency_code || null,
          sendEmail: true,
        }).catch(() => {}); // fire-and-forget, don't block webhook response
      }
    }

    // ── Mark transaction as processed (dedup key, expires in 30 days) ──
    await redis.set(keys.txnDedup(txnId), JSON.stringify({
      installId,
      credits: totalCredits,
      unlimited: grantsUnlimited,
      course: isCoursePurchase,
      processedAt: new Date().toISOString(),
    }), 'EX', 60 * 60 * 24 * 30);

    if (result) {
      console.log(`Auto-credited ${totalCredits} credits to ${installId} (txn: ${txnId}). Balance: ${result.newBalance}, expires: ${new Date(result.expiresAt).toISOString()}`);
    } else {
      console.log(`Marked lifetime purchase complete for ${installId} (txn: ${txnId}).`);
    }

    return res.status(200).json({
      received: true,
      credited: totalCredits,
      newBalance: result ? result.newBalance : null,
      expiresAt: result ? result.expiresAt : null,
      unlimited: grantsUnlimited,
      installId,
    });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).json({ error: 'Internal processing error' });
  }
};

