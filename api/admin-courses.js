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
  safeParse,
  DEFAULT_COURSE_ID,
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
        progressUrl: `${process.env.CUSTOMER_PORTAL_URL || 'https://map-scrapper-five.vercel.app/portal/'}?course=${encodeURIComponent(course.id)}`,
      });
      return res.status(200).json({ ok: true });
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
