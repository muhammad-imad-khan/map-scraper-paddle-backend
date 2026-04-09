const {
  cors,
  getRedis,
  listEnrollments,
  updateCourseProgress,
  safeParse,
  grantCourseAccess,
  DEFAULT_COURSE_ID,
  BASE_URL,
  PADDLE_API_KEY,
} = require('../lib/helpers');
const crypto = require('crypto');

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return resolve(req.body);
    }
    if (Buffer.isBuffer(req.body)) {
      try { return resolve(JSON.parse(req.body.toString('utf8'))); } catch { return resolve({}); }
    }
    if (typeof req.body === 'string' && req.body.length > 0) {
      try { return resolve(JSON.parse(req.body)); } catch { return resolve({}); }
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
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
  const userRaw = await redis.get(`user:${String(session.email).toLowerCase()}`);
  const user = safeParse(userRaw, null);
  if (!user) return null;
  return user;
}

function toTimestamp(value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? t : 0;
}

function getCoursePurchaseSummary(user) {
  const purchases = Array.isArray(user?.purchases) ? user.purchases : [];
  const coursePurchases = purchases.filter((p) => {
    if (!p || typeof p !== 'object') return false;
    if (p.course === true) return true;
    if (p.courseId) return true;
    const label = String(p.label || '').toLowerCase();
    return label.includes('course');
  });

  let latest = null;
  for (const purchase of coursePurchases) {
    if (!latest) {
      latest = purchase;
      continue;
    }
    const currentTs = toTimestamp(purchase.completedAt || purchase.createdAt);
    const latestTs = toTimestamp(latest.completedAt || latest.createdAt);
    if (currentTs >= latestTs) latest = purchase;
  }

  return {
    hasCompleted: coursePurchases.some((p) => String(p.status || '').toLowerCase() === 'completed'),
    hasPending: coursePurchases.some((p) => String(p.status || '').toLowerCase() === 'pending'),
    latestPending: coursePurchases
      .filter((p) => String(p.status || '').toLowerCase() === 'pending')
      .sort((a, b) => toTimestamp(b.createdAt || b.completedAt) - toTimestamp(a.createdAt || a.completedAt))[0] || null,
    latest,
  };
}

async function verifyTransactionCompleted(txnId) {
  const normalizedTxn = String(txnId || '').trim();
  if (!normalizedTxn || !normalizedTxn.startsWith('txn_') || !PADDLE_API_KEY) return false;
  try {
    const resp = await fetch(`${BASE_URL}/transactions/${normalizedTxn}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${PADDLE_API_KEY}`,
        Accept: 'application/json',
      },
    });
    const data = await resp.json().catch(() => ({}));
    const status = String(data?.data?.status || '').toLowerCase();
    return status === 'completed' || status === 'billed';
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const redis = getRedis();
    const body = await readBody(req);
    const action = String(body.action || 'dashboard');
    const clientId = normalizeClientId(body.clientId || req.headers['x-client-id']);
    const user = await getSessionUser(req, body.token, clientId, redis);

    if (!user) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    if (action === 'dashboard') {
      let enrollments = await listEnrollments({ email: user.email }, redis);
      let activeCourses = enrollments.filter((entry) => entry.status === 'active' && entry.course && entry.course.status !== 'archived');
      const notifications = [];

      const purchaseSummary = getCoursePurchaseSummary(user);
      if (!activeCourses.length && purchaseSummary.hasCompleted) {
        try {
          await grantCourseAccess({
            email: user.email,
            name: user.name,
            courseId: DEFAULT_COURSE_ID,
            source: 'portal_auto_recover',
            txnId: purchaseSummary.latest?.txnId || 'portal-auto-recover',
            amount: purchaseSummary.latest?.amount || null,
            currency: purchaseSummary.latest?.currency || null,
            sendEmail: false,
          }, redis);
          enrollments = await listEnrollments({ email: user.email }, redis);
          activeCourses = enrollments.filter((entry) => entry.status === 'active' && entry.course && entry.course.status !== 'archived');
          notifications.push({
            type: 'ok',
            message: 'Your completed course purchase was detected and access has been activated in your portal.',
          });
        } catch (recoverErr) {
          notifications.push({
            type: 'error',
            message: `We detected your payment but could not activate access automatically yet: ${recoverErr?.message || 'unknown error'}. Support can finalize this quickly.`,
          });
        }
      }

      if (purchaseSummary.hasPending) {
        let activatedFromPending = false;
        if (!activeCourses.length && purchaseSummary.latestPending?.txnId) {
          const isCompletedInPaddle = await verifyTransactionCompleted(purchaseSummary.latestPending.txnId);
          if (isCompletedInPaddle) {
            try {
              await grantCourseAccess({
                email: user.email,
                name: user.name,
                courseId: DEFAULT_COURSE_ID,
                source: 'portal_pending_verify',
                txnId: purchaseSummary.latestPending.txnId,
                amount: purchaseSummary.latestPending?.amount || null,
                currency: purchaseSummary.latestPending?.currency || null,
                sendEmail: false,
              }, redis);

              const purchases = Array.isArray(user.purchases) ? user.purchases : [];
              const now = new Date().toISOString();
              for (const p of purchases) {
                if (p && p.txnId === purchaseSummary.latestPending.txnId && String(p.status || '').toLowerCase() === 'pending') {
                  p.status = 'completed';
                  p.completedAt = now;
                }
              }
              await redis.set(`user:${String(user.email || '').toLowerCase()}`, JSON.stringify({ ...user, purchases }));

              enrollments = await listEnrollments({ email: user.email }, redis);
              activeCourses = enrollments.filter((entry) => entry.status === 'active' && entry.course && entry.course.status !== 'archived');
              notifications.push({
                type: 'ok',
                message: 'Payment confirmation was detected from Paddle and your course is now unlocked in the portal.',
              });
              activatedFromPending = true;
            } catch (pendingRecoverErr) {
              notifications.push({
                type: 'error',
                message: `Your payment appears completed, but automatic portal activation failed: ${pendingRecoverErr?.message || 'unknown error'}. Support can activate it manually.`,
              });
            }
          }
        }

        if (activatedFromPending) {
          // Skip pending warning once access is already activated in this request.
        } else {
        notifications.push({
          type: 'pending',
          message: 'Your payment is still processing. Course access appears automatically once Paddle confirms the transaction.',
        });
        }
      }

      if (activeCourses.length && purchaseSummary.hasCompleted) {
        notifications.push({
          type: 'ok',
          message: 'Purchase confirmed. Your course is unlocked in this customer portal.',
        });
      }

      return res.status(200).json({
        ok: true,
        user: {
          name: user.name,
          email: user.email,
          createdAt: user.createdAt || null,
        },
        courses: activeCourses,
        purchases: Array.isArray(user.purchases) ? user.purchases : [],
        notifications,
      });
    }

    if (action === 'updateProgress') {
      const courseId = String(body.courseId || '').trim();
      const itemId = String(body.itemId || '').trim();
      const enrollment = (await listEnrollments({ email: user.email, courseId }, redis))[0];
      if (!enrollment) {
        return res.status(403).json({ error: 'Course access not found.' });
      }
      const progress = await updateCourseProgress({
        email: user.email,
        courseId,
        itemId,
        completed: typeof body.completed === 'boolean' ? body.completed : undefined,
        secondsWatched: body.secondsWatched,
      }, redis);
      return res.status(200).json({ ok: true, progress });
    }

    return res.status(400).json({ error: 'Invalid action.' });
  } catch (err) {
    console.error('customer-portal error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
