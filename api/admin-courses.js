const {
  cors,
  getRedis,
  listCourses,
  listEnrollments,
  saveCourse,
  deleteCourse,
  getCourse,
  grantCourseAccess,
  sendPortalAccessEmail,
  sendSimpleCourseLinkEmail,
  safeParse,
  DEFAULT_COURSE_ID,
  CUSTOMER_PORTAL_URL,
} = require('../lib/helpers');

function getAdminKey(req) {
  const fromHeader = (req.headers['x-admin-key'] || '').toString().trim();
  if (fromHeader) return fromHeader;
  const auth = (req.headers.authorization || '').toString();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

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

async function listCourseTransfers(redis, status) {
  const statuses = status === 'all' ? ['pending', 'approved', 'rejected'] : [status || 'pending'];
  const ids = [];
  for (const currentStatus of statuses) {
    const items = await redis.lrange(`banktransfers:${currentStatus}`, 0, -1);
    ids.push(...items);
  }

  const rows = [];
  for (const id of ids) {
    const raw = await redis.get(`banktransfer:${id}`);
    const record = safeParse(raw, null);
    if (!record || record.purchaseType !== 'course') continue;
    rows.push(record);
  }
  return rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function listCourseCardPurchases(redis, status = 'all') {
  const rows = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'user:*', 'COUNT', 200);
    cursor = nextCursor;
    if (!keys.length) continue;

    const pipeline = redis.pipeline();
    keys.forEach((key) => pipeline.get(key));
    const results = await pipeline.exec();

    for (const entry of results) {
      const user = safeParse(entry && entry[1], null);
      if (!user || !Array.isArray(user.purchases)) continue;
      const email = String(user.email || '').toLowerCase();

      for (const purchase of user.purchases) {
        if (!purchase || typeof purchase !== 'object') continue;
        const isCourse = purchase.course === true || Boolean(purchase.courseId) || String(purchase.label || '').toLowerCase().includes('course');
        if (!isCourse) continue;

        const purchaseStatus = String(purchase.status || 'unknown').toLowerCase();
        if (status !== 'all' && purchaseStatus !== status) continue;

        rows.push({
          id: purchase.txnId || `${email}:${purchase.createdAt || ''}`,
          source: purchase.source || 'card',
          channel: 'credit_debit',
          email,
          name: user.name || '',
          label: purchase.label || 'Course Purchase',
          courseId: purchase.courseId || DEFAULT_COURSE_ID,
          priceId: purchase.priceId || null,
          status: purchaseStatus,
          amount: purchase.amount || null,
          currency: purchase.currency || null,
          txnId: purchase.txnId || null,
          reference: purchase.txnId || null,
          receiptDataUrl: null,
          receiptName: null,
          receiptMimeType: null,
          createdAt: purchase.createdAt || null,
          completedAt: purchase.completedAt || null,
        });
      }
    }
  } while (cursor !== '0');

  return rows.sort((a, b) => String(b.completedAt || b.createdAt || '').localeCompare(String(a.completedAt || a.createdAt || '')));
}

async function listUnifiedCoursePurchases(redis, status = 'all') {
  const [cardPurchases, courseTransfers] = await Promise.all([
    listCourseCardPurchases(redis, status),
    listCourseTransfers(redis, status === 'all' ? 'all' : status),
  ]);

  const transferRows = courseTransfers.map((record) => ({
    id: record.id,
    source: 'bank_transfer',
    channel: 'bank_transfer',
    email: record.email || '',
    name: record.name || '',
    label: record.pack || record.courseId || 'Course Purchase',
    courseId: record.courseId || DEFAULT_COURSE_ID,
    priceId: null,
    status: String(record.status || 'pending').toLowerCase(),
    amount: record.amount || null,
    currency: record.currency || null,
    txnId: null,
    createdAt: record.createdAt || null,
    completedAt: record.approvedAt || null,
    bankTransferId: record.id,
    reference: record.reference || null,
    receiptDataUrl: record.receiptDataUrl || null,
    receiptName: record.receiptName || null,
    receiptMimeType: record.receiptMimeType || null,
  }));

  const allRows = cardPurchases.concat(transferRows);
  return allRows.sort((a, b) => String(b.completedAt || b.createdAt || '').localeCompare(String(a.completedAt || a.createdAt || '')));
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

  if (getAdminKey(req) !== configuredAdminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const redis = getRedis();

    if (req.method === 'GET') {
      const query = req.query || {};
      const type = String(query.type || 'courses').toLowerCase();

      if (type === 'courses') {
        const courses = await listCourses(redis);
        return res.status(200).json({ ok: true, items: courses });
      }

      if (type === 'enrollments') {
        const items = await listEnrollments({ courseId: query.courseId, email: query.email }, redis);
        return res.status(200).json({ ok: true, count: items.length, items });
      }

      if (type === 'transfers') {
        const items = await listCourseTransfers(redis, String(query.status || 'pending').toLowerCase());
        return res.status(200).json({ ok: true, count: items.length, items });
      }

      if (type === 'purchases') {
        const items = await listUnifiedCoursePurchases(redis, String(query.status || 'all').toLowerCase());
        return res.status(200).json({ ok: true, count: items.length, items });
      }

      if (type === 'overview') {
        const [courses, enrollments, transfers] = await Promise.all([
          listCourses(redis),
          listEnrollments({}, redis),
          listCourseTransfers(redis, 'pending'),
        ]);
        return res.status(200).json({
          ok: true,
          stats: {
            courses: courses.length,
            enrollments: enrollments.length,
            pendingTransfers: transfers.length,
          },
        });
      }

      return res.status(400).json({ error: 'Invalid type.' });
    }

    const body = await readBody(req);
    const action = String(body.action || '');

    if (action === 'saveCourse') {
      const course = await saveCourse(body.course || {}, redis);
      return res.status(200).json({ ok: true, course });
    }

    if (action === 'deleteCourse') {
      await deleteCourse(body.courseId, redis);
      return res.status(200).json({ ok: true, deleted: true });
    }

    if (action === 'grantAccess') {
      const result = await grantCourseAccess({
        email: body.email,
        name: body.name,
        courseId: body.courseId || DEFAULT_COURSE_ID,
        source: body.source || 'admin',
        sendEmail: body.sendEmail !== false,
        forceEmail: Boolean(body.forceEmail),
      }, redis);
      return res.status(200).json({ ok: true, result });
    }

    if (action === 'sendAccessEmail') {
      const course = await getCourse(body.courseId || DEFAULT_COURSE_ID, redis);
      if (!course) return res.status(404).json({ error: 'Course not found.' });
      const enrollment = (await listEnrollments({ courseId: course.id, email: body.email }, redis))[0];
      await sendPortalAccessEmail({
        email: body.email,
        name: body.name || enrollment?.name || '',
        course,
        createdAccount: false,
        temporaryPassword: null,
        progressUrl: `${CUSTOMER_PORTAL_URL}?course=${encodeURIComponent(course.id)}`,
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'sendPurchaseEmail') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'email is required.' });
      await sendSimpleCourseLinkEmail({
        from: body.from || null,
        email,
        name: body.name || '',
      });
      return res.status(200).json({ ok: true, message: `Course link email sent to ${email}.` });
    }

    if (action === 'validatePurchase') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'email is required.' });

      const source = String(body.source || '').toLowerCase();
      const courseId = body.courseId || DEFAULT_COURSE_ID;
      const now = new Date().toISOString();
      let transfer = null;

      const userKey = `user:${email}`;
      const userRaw = await redis.get(userKey);
      const userData = safeParse(userRaw, null);
      if (userData && Array.isArray(userData.purchases)) {
        const purchase = userData.purchases.find((entry) => {
          if (!entry || typeof entry !== 'object') return false;
          const entryTxn = String(entry.txnId || '').trim();
          const bodyTxn = String(body.txnId || '').trim();
          return bodyTxn && entryTxn && entryTxn === bodyTxn;
        });
        if (purchase) {
          purchase.adminValidatedAt = now;
          purchase.adminValidatedBy = 'admin';
          purchase.status = purchase.status === 'pending' ? 'completed' : purchase.status;
          await redis.set(userKey, JSON.stringify(userData));
        }
      }

      if (source === 'bank_transfer' && body.bankTransferId) {
        const btId = String(body.bankTransferId || '').trim();
        const raw = await redis.get(`banktransfer:${btId}`);
        transfer = safeParse(raw, null);
        if (!transfer || transfer.purchaseType !== 'course') {
          return res.status(404).json({ error: 'Course transfer not found.' });
        }
      }

      const result = await grantCourseAccess({
        email,
        name: body.name || transfer?.name || '',
        courseId,
        source: source || (transfer ? 'bank_transfer' : 'admin_validation'),
        txnId: body.txnId || null,
        bankTransferId: transfer?.id || body.bankTransferId || null,
        amount: body.amount || transfer?.amount || null,
        currency: body.currency || transfer?.currency || null,
        sendEmail: true,
        forceEmail: true,
      }, redis);

      await sendSimpleCourseLinkEmail({
        from: body.from || null,
        email,
        name: body.name || transfer?.name || '',
      });

      if (transfer && String(transfer.status || '').toLowerCase() !== 'approved') {
        transfer.status = 'approved';
        transfer.approvedAt = now;
        transfer.approvedBy = 'admin';
        transfer.adminValidatedAt = now;
        transfer.adminValidatedBy = 'admin';
        transfer.courseId = courseId;
        transfer.courseAccessGranted = true;
        await redis.set(`banktransfer:${transfer.id}`, JSON.stringify(transfer));
        await redis.lrem('banktransfers:pending', 0, transfer.id);
        await redis.lrem('banktransfers:rejected', 0, transfer.id);
        await redis.lpush('banktransfers:approved', transfer.id);
      }

      // Log validation event for monitoring
      const logEntry = {
        email,
        courseId,
        source,
        txnId: body.txnId || null,
        bankTransferId: body.bankTransferId || null,
        status: 'success',
        timestamp: now,
        adminUser: body.adminUser || 'auto',
      };
      const logKey = `validation:log:${new Date().toISOString().split('T')[0]}`;
      try {
        const logList = await redis.get(logKey);
        let logs = [];
        if (logList) {
          const parsed = safeParse(logList, null);
          logs = Array.isArray(parsed) ? parsed : [];
        }
        logs.push(logEntry);
        await redis.set(logKey, JSON.stringify(logs.slice(-500))); // Keep last 500 validations
        await redis.expire(logKey, 30 * 24 * 60 * 60); // 30 days
      } catch (logErr) {
        // Log error but don't fail validation
        console.error('Validation log error:', logErr.message);
      }

      return res.status(200).json({
        ok: true,
        message: `Purchase validated. Course email + portal notification sent to ${email}.`,
        transfer: transfer || null,
        result,
      });
    }

    if (action === 'validation-logs') {
      // Retrieve validation logs for monitoring/metrics
      const days = parseInt(body.days || '7', 10);
      const logs = [];
      const now = new Date();
      
      for (let i = 0; i < days; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        const logKey = `validation:log:${dateStr}`;
        const raw = await redis.get(logKey);
        const dayLogs = safeParse(raw, null) || [];
        if (Array.isArray(dayLogs)) {
          logs.push(...dayLogs);
        }
      }

      const stats = {
        totalValidations: logs.length,
        bySource: {},
        byStatus: {},
        byDate: {},
        recentErrors: [],
      };

      logs.forEach((log) => {
        if (!log || typeof log !== 'object') return;
        stats.bySource[log.source] = (stats.bySource[log.source] || 0) + 1;
        stats.byStatus[log.status] = (stats.byStatus[log.status] || 0) + 1;
        const dateStr = log.timestamp?.split('T')[0] || 'unknown';
        stats.byDate[dateStr] = (stats.byDate[dateStr] || 0) + 1;
        if (log.status !== 'success') {
          stats.recentErrors.push(log);
        }
      });

      return res.status(200).json({
        ok: true,
        stats,
        logs: logs.slice(-50), // Return most recent 50
      });
    }

    if (action === 'approveCourseTransfer') {
      const btId = String(body.btId || '').trim();
      if (!btId) return res.status(400).json({ error: 'btId is required.' });

      const raw = await redis.get(`banktransfer:${btId}`);
      const transfer = safeParse(raw, null);
      if (!transfer || transfer.purchaseType !== 'course') {
        return res.status(404).json({ error: 'Course transfer not found.' });
      }

      const courseId = body.courseId || transfer.courseId || DEFAULT_COURSE_ID;
      const result = await grantCourseAccess({
        email: transfer.email,
        name: transfer.name,
        courseId,
        source: 'bank_transfer',
        bankTransferId: btId,
        amount: transfer.amount || null,
        currency: transfer.currency || null,
        sendEmail: body.sendEmail !== false,
        forceEmail: true,
      }, redis);

      transfer.status = 'approved';
      transfer.approvedAt = new Date().toISOString();
      transfer.approvedBy = 'admin';
      transfer.courseId = courseId;
      transfer.courseAccessGranted = true;
      await redis.set(`banktransfer:${btId}`, JSON.stringify(transfer));
      await redis.lrem('banktransfers:pending', 0, btId);
      await redis.lpush('banktransfers:approved', btId);

      return res.status(200).json({ ok: true, transfer, result });
    }

    if (action === 'rejectCourseTransfer') {
      const btId = String(body.btId || '').trim();
      if (!btId) return res.status(400).json({ error: 'btId is required.' });
      const raw = await redis.get(`banktransfer:${btId}`);
      const transfer = safeParse(raw, null);
      if (!transfer || transfer.purchaseType !== 'course') {
        return res.status(404).json({ error: 'Course transfer not found.' });
      }
      transfer.status = 'rejected';
      transfer.rejectedAt = new Date().toISOString();
      transfer.rejectedBy = 'admin';
      transfer.rejectionReason = body.reason || '';
      await redis.set(`banktransfer:${btId}`, JSON.stringify(transfer));
      await redis.lrem('banktransfers:pending', 0, btId);
      await redis.lpush('banktransfers:rejected', btId);
      return res.status(200).json({ ok: true, transfer });
    }

    return res.status(400).json({ error: 'Invalid action.' });
  } catch (err) {
    console.error('admin-courses error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
