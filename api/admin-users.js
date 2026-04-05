// GET /api/admin-users
// Secure admin endpoint to paginate through auth users and install subscriptions.
// Query:
//   type=users|installs (default: users)
//   cursor=<redis-scan-cursor> (default: 0)
//   limit=<1..200> (default: 50)
// Auth:
//   X-Admin-Key: <ADMIN_API_KEY>
//   or Authorization: Bearer <ADMIN_API_KEY>
const { cors, getRedis, keys, isValidInstallId, sendPurchaseNotification } = require('./_helpers');

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function getAdminKey(req) {
  const fromHeader = (req.headers['x-admin-key'] || '').toString().trim();
  if (fromHeader) return fromHeader;

  const auth = (req.headers.authorization || '').toString();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

function parseLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

function asIsoTimestamp(ms) {
  if (!ms) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function listUsers(redis, cursor, limit) {
  const [nextCursor, foundKeys] = await redis.scan(cursor, 'MATCH', 'user:*', 'COUNT', limit);
  const pipe = redis.pipeline();
  foundKeys.forEach((k) => pipe.get(k));
  const results = await pipe.exec();

  const items = [];
  for (let i = 0; i < foundKeys.length; i++) {
    const err = results[i] && results[i][0];
    const raw = results[i] && results[i][1];
    if (err || !raw) continue;

    const user = safeParse(raw);
    if (!user || !user.email) continue;

    items.push({
      email: user.email,
      name: user.name || null,
      createdAt: user.createdAt || null,
      purchasesCount: Array.isArray(user.purchases) ? user.purchases.length : 0,
    });
  }

  return {
    type: 'users',
    cursor: nextCursor,
    hasMore: nextCursor !== '0',
    count: items.length,
    items,
  };
}

async function listInstalls(redis, cursor, limit) {
  const [nextCursor, installKeys] = await redis.scan(cursor, 'MATCH', 'install:*', 'COUNT', limit);
  const ids = installKeys.map((k) => k.slice('install:'.length));

  const pipe = redis.pipeline();
  for (const id of ids) {
    pipe.get(keys.install(id));
    pipe.get(keys.credits(id));
    pipe.get(keys.expiry(id));
    pipe.llen(keys.txnLog(id));
    pipe.lindex(keys.txnLog(id), -1);
  }
  const rows = await pipe.exec();

  const now = Date.now();
  const items = [];
  for (let i = 0; i < ids.length; i++) {
    const base = i * 5;
    const installRaw = rows[base] && rows[base][1];
    const creditsRaw = rows[base + 1] && rows[base + 1][1];
    const expiryRaw = rows[base + 2] && rows[base + 2][1];
    const txnCountRaw = rows[base + 3] && rows[base + 3][1];
    const lastTxnRaw = rows[base + 4] && rows[base + 4][1];

    const install = installRaw ? safeParse(installRaw) : null;
    const lastTxn = lastTxnRaw ? safeParse(lastTxnRaw) : null;
    const expiryMs = expiryRaw ? Number(expiryRaw) : null;
    const txnCount = Number(txnCountRaw || 0);

    items.push({
      installId: ids[i],
      createdAt: install && install.createdAt ? install.createdAt : null,
      credits: creditsRaw === null ? null : Number(creditsRaw),
      expiresAt: asIsoTimestamp(expiryMs),
      subscriptionActive: Boolean(expiryMs && expiryMs > now),
      txnCount,
      lastTxnAt: lastTxn && lastTxn.at ? lastTxn.at : null,
      lastTxnReason: lastTxn && lastTxn.reason ? lastTxn.reason : null,
    });
  }

  return {
    type: 'installs',
    cursor: nextCursor,
    hasMore: nextCursor !== '0',
    count: items.length,
    items,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const configuredAdminKey = (process.env.ADMIN_API_KEY || '').trim();
  if (!configuredAdminKey) {
    return res.status(500).json({ error: 'ADMIN_API_KEY is not configured.' });
  }

  const requestAdminKey = getAdminKey(req);
  if (!requestAdminKey || requestAdminKey !== configuredAdminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const redis = getRedis();

    if (req.method === 'GET') {
      const query = req.query || {};
      const type = (query.type || 'users').toString().toLowerCase();
      const cursor = (query.cursor || '0').toString();
      const limit = parseLimit(query.limit);

      if (type !== 'users' && type !== 'installs') {
        return res.status(400).json({ error: 'Invalid type. Use users or installs.' });
      }

      const payload = type === 'users'
        ? await listUsers(redis, cursor, limit)
        : await listInstalls(redis, cursor, limit);

      return res.status(200).json(payload);
    }

    const body = req.body || {};
    const action = (body.action || '').toString();

    if (action === 'adjustCredits') {
      const installId = (body.installId || '').toString().trim();
      const delta = Number(body.delta);
      const reason = (body.reason || 'admin-adjustment').toString().slice(0, 120);

      if (!isValidInstallId(installId)) {
        return res.status(400).json({ error: 'Invalid installId.' });
      }
      if (!Number.isFinite(delta) || Math.floor(delta) !== delta || delta === 0) {
        return res.status(400).json({ error: 'delta must be a non-zero integer.' });
      }

      const balance = await redis.incrby(keys.credits(installId), delta);
      const entry = {
        type: 'admin-adjustment',
        amount: delta,
        reason,
        balance,
        at: new Date().toISOString(),
      };
      await redis.rpush(keys.txnLog(installId), JSON.stringify(entry));

      return res.status(200).json({ ok: true, installId, balance, entry });
    }

    if (action === 'setCredits') {
      const installId = (body.installId || '').toString().trim();
      const credits = Number(body.credits);

      if (!isValidInstallId(installId)) {
        return res.status(400).json({ error: 'Invalid installId.' });
      }
      if (!Number.isFinite(credits) || Math.floor(credits) !== credits || credits < 0) {
        return res.status(400).json({ error: 'credits must be an integer >= 0.' });
      }

      await redis.set(keys.credits(installId), credits);
      const entry = {
        type: 'admin-set-credits',
        amount: credits,
        reason: 'admin-set',
        balance: credits,
        at: new Date().toISOString(),
      };
      await redis.rpush(keys.txnLog(installId), JSON.stringify(entry));

      return res.status(200).json({ ok: true, installId, balance: credits });
    }

    if (action === 'setExpiry') {
      const installId = (body.installId || '').toString().trim();
      const expiresAt = body.expiresAt;

      if (!isValidInstallId(installId)) {
        return res.status(400).json({ error: 'Invalid installId.' });
      }

      if (expiresAt === null || expiresAt === '' || typeof expiresAt === 'undefined') {
        await redis.del(keys.expiry(installId));
        return res.status(200).json({ ok: true, installId, expiresAt: null });
      }

      const expiryMs = Date.parse(String(expiresAt));
      if (!Number.isFinite(expiryMs)) {
        return res.status(400).json({ error: 'Invalid expiresAt datetime.' });
      }

      await redis.set(keys.expiry(installId), expiryMs);
      return res.status(200).json({ ok: true, installId, expiresAt: new Date(expiryMs).toISOString() });
    }

    if (action === 'deleteUser') {
      const email = (body.email || '').toString().trim().toLowerCase();
      if (!email) {
        return res.status(400).json({ error: 'email is required.' });
      }

      const userKey = `user:${email}`;
      const removed = await redis.del(userKey);

      return res.status(200).json({ ok: true, email, deleted: removed > 0 });
    }

    // ── Send test email ──
    if (action === 'testEmail') {
      try {
        await sendPurchaseNotification({
          userName: 'Test User',
          userEmail: 'test@example.com',
          packLabel: 'Pro Pack (TEST)',
          credits: 500,
          amount: '5.00',
          currency: 'USD',
          txnId: 'txn_test_' + Date.now(),
        });
        return res.status(200).json({ ok: true, message: 'Test email sent successfully.' });
      } catch (err) {
        return res.status(500).json({ error: 'Failed to send test email: ' + err.message });
      }
    }

    // ── Monthly sales report ──
    if (action === 'monthlyReport') {
      const targetMonth = (body.month || '').toString().trim(); // YYYY-MM format, optional
      let cursor = '0';
      const allPurchases = [];

      // Scan all user keys to collect completed purchases
      do {
        const [nextCursor, foundKeys] = await redis.scan(cursor, 'MATCH', 'user:*', 'COUNT', 200);
        cursor = nextCursor;
        if (foundKeys.length === 0) continue;

        const pipe = redis.pipeline();
        foundKeys.forEach(k => pipe.get(k));
        const results = await pipe.exec();

        for (let i = 0; i < foundKeys.length; i++) {
          const err = results[i] && results[i][0];
          const raw = results[i] && results[i][1];
          if (err || !raw) continue;
          const user = safeParse(raw);
          if (!user || !user.email || !Array.isArray(user.purchases)) continue;

          for (const p of user.purchases) {
            if (p.status !== 'completed') continue;
            const date = p.completedAt || p.createdAt;
            if (!date) continue;
            const month = date.slice(0, 7); // YYYY-MM
            if (targetMonth && month !== targetMonth) continue;
            allPurchases.push({
              email: user.email,
              name: user.name || null,
              pack: p.label || p.priceId || 'Unknown',
              credits: p.credits || 0,
              amount: p.amount || null,
              currency: p.currency || null,
              txnId: p.txnId || null,
              date,
              month,
            });
          }
        }
      } while (cursor !== '0');

      // Aggregate by month
      const months = {};
      for (const p of allPurchases) {
        if (!months[p.month]) {
          months[p.month] = { month: p.month, totalSales: 0, totalRevenue: 0, purchases: [] };
        }
        months[p.month].totalSales++;
        if (p.amount) months[p.month].totalRevenue += Number(p.amount) || 0;
        months[p.month].purchases.push(p);
      }

      // Sort months descending
      const sortedMonths = Object.values(months).sort((a, b) => b.month.localeCompare(a.month));

      // If amounts are in minor units (cents), convert to dollars
      for (const m of sortedMonths) {
        m.totalRevenue = (m.totalRevenue / 100).toFixed(2);
      }

      return res.status(200).json({
        ok: true,
        totalPurchases: allPurchases.length,
        months: sortedMonths,
      });
    }

    // ── List bank transfer requests ──
    if (action === 'listBankTransfers') {
      const statusFilter = (body.status || 'pending').toString();
      const listKey = statusFilter === 'all' ? null : `banktransfers:${statusFilter}`;

      let ids = [];
      if (listKey) {
        ids = await redis.lrange(listKey, 0, -1);
      } else {
        const pending = await redis.lrange('banktransfers:pending', 0, -1);
        const approved = await redis.lrange('banktransfers:approved', 0, -1);
        const rejected = await redis.lrange('banktransfers:rejected', 0, -1);
        ids = [...pending, ...approved, ...rejected];
      }

      const items = [];
      for (const id of ids) {
        const raw = await redis.get(`banktransfer:${id}`);
        if (raw) items.push(JSON.parse(raw));
      }

      return res.status(200).json({ ok: true, count: items.length, items });
    }

    // ── Approve bank transfer (add credits to install) ──
    if (action === 'approveBankTransfer') {
      const btId = (body.btId || '').toString().trim();
      const credits = Number(body.credits);
      const installId = (body.installId || '').toString().trim();

      if (!btId) return res.status(400).json({ error: 'btId is required.' });

      const raw = await redis.get(`banktransfer:${btId}`);
      if (!raw) return res.status(404).json({ error: 'Bank transfer not found.' });

      const bt = JSON.parse(raw);
      bt.status = 'approved';
      bt.approvedAt = new Date().toISOString();
      bt.approvedBy = 'admin';
      bt.creditsGranted = credits || 0;

      // Add credits if installId and credits provided
      if (installId && isValidInstallId(installId) && credits > 0) {
        const { addCredits } = require('./_helpers');
        await addCredits(installId, credits, `banktransfer:${btId}`);
        bt.installId = installId;
      }

      await redis.set(`banktransfer:${btId}`, JSON.stringify(bt));
      // Move from pending to approved list
      await redis.lrem('banktransfers:pending', 0, btId);
      await redis.lpush('banktransfers:approved', btId);

      return res.status(200).json({ ok: true, bt });
    }

    // ── Reject bank transfer ──
    if (action === 'rejectBankTransfer') {
      const btId = (body.btId || '').toString().trim();
      if (!btId) return res.status(400).json({ error: 'btId is required.' });

      const raw = await redis.get(`banktransfer:${btId}`);
      if (!raw) return res.status(404).json({ error: 'Bank transfer not found.' });

      const bt = JSON.parse(raw);
      bt.status = 'rejected';
      bt.rejectedAt = new Date().toISOString();
      await redis.set(`banktransfer:${btId}`, JSON.stringify(bt));
      await redis.lrem('banktransfers:pending', 0, btId);
      await redis.lpush('banktransfers:rejected', btId);

      return res.status(200).json({ ok: true, bt });
    }

    return res.status(400).json({ error: 'Invalid action.' });
  } catch (err) {
    console.error('admin-users error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
