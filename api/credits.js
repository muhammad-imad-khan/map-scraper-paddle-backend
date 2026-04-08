// GET/POST /api/credits
// GET  → returns current balance for installId
// POST → deducts credits (called by extension during scraping)
//
// Security: installId is a UUID generated client-side on first install.
// All credit mutations happen server-side with atomic Redis operations.
const { cors, isValidInstallId, getCredits, initUser, deductCredits, sendInstallNotification, sendLowCreditsEmail, getRedis, keys, LOW_CREDITS_THRESHOLD } = require('../lib/helpers');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const installId = req.headers['x-install-id'] || req.query.installId;
  if (!isValidInstallId(installId)) {
    return res.status(400).json({ error: 'Missing or invalid installId' });
  }

  // GET → fetch balance (init user if first time)
  if (req.method === 'GET') {
    try {
      const result = await initUser(installId);
      if (result.isNew) {
        sendInstallNotification({ installId }).catch(() => {});
      }

      const response = {
        credits: result.credits,
        installId,
        expired: result.expired,
        expiresAt: result.expiresAt,
      };

      // If ?history=1, include transaction log (purchases + deductions)
      if (req.query.history === '1') {
        const redis = getRedis();
        const txns = await redis.lrange(keys.txnLog(installId), 0, -1);
        response.history = txns.map(t => { try { return JSON.parse(t); } catch { return null; } }).filter(Boolean);
      }

      return res.status(200).json(response);
    } catch (err) {
      console.error('Credits GET error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // POST → deduct credits or save email
  if (req.method === 'POST') {
    const body = req.body || {};

    // ── Save email for install (for marketing + low-credit alerts) ──
    if (body.action === 'saveEmail') {
      const email = (body.email || '').toString().trim().toLowerCase();
      const name = (body.name || '').toString().trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address.' });
      }
      try {
        const redis = getRedis();
        const installKey = keys.install(installId);
        const raw = await redis.get(installKey);
        const data = raw ? JSON.parse(raw) : { createdAt: new Date().toISOString() };
        data.email = email;
        if (name) data.name = name;
        await redis.set(installKey, JSON.stringify(data));
        return res.status(200).json({ ok: true, email });
      } catch (err) {
        console.error('saveEmail error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    // ── Deduct credits (for scraping) ──
    const { amount } = body;
    const cost = parseInt(amount, 10) || 1;
    if (cost < 1 || cost > 100) {
      return res.status(400).json({ error: 'Invalid amount (1-100)' });
    }

    try {
      // Check expiry before deducting
      const current = await getCredits(installId);
      if (current.expired || current.credits === 0) {
        return res.status(402).json({ error: 'Credits expired', credits: 0, expired: true });
      }

      const newBal = await deductCredits(installId, cost);
      if (newBal < 0) {
        return res.status(402).json({ error: 'Insufficient credits', credits: current.credits || 0 });
      }

      // Send low-credits warning email if balance drops to threshold
      if (newBal > 0 && newBal <= LOW_CREDITS_THRESHOLD) {
        const redis = getRedis();
        const dedupKey = `lowcredit:${installId}`;
        const alreadySent = await redis.get(dedupKey);
        if (!alreadySent) {
          // Get user email from install data
          const installRaw = await redis.get(keys.install(installId));
          if (installRaw) {
            const installData = JSON.parse(installRaw);
            if (installData.email) {
              sendLowCreditsEmail({
                email: installData.email,
                name: installData.name,
                credits: newBal,
                installId,
              }).catch(() => {});
              // Don't send again for 24 hours
              await redis.set(dedupKey, '1', 'EX', 86400);
            }
          }
        }
      }

      return res.status(200).json({ credits: newBal, deducted: cost, expiresAt: current.expiresAt });
    } catch (err) {
      console.error('Credits POST error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

