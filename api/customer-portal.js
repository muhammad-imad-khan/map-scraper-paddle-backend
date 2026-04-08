const {
  cors,
  getRedis,
  listEnrollments,
  updateCourseProgress,
  safeParse,
} = require('./_helpers');

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

async function getSessionUser(token, redis) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return null;
  const sessionRaw = await redis.get(`session:${normalizedToken}`);
  const session = safeParse(sessionRaw, null);
  if (!session || !session.email) return null;
  const userRaw = await redis.get(`user:${String(session.email).toLowerCase()}`);
  const user = safeParse(userRaw, null);
  if (!user) return null;
  return user;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const redis = getRedis();
    const body = await readBody(req);
    const action = String(body.action || 'dashboard');
    const user = await getSessionUser(body.token, redis);

    if (!user) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    if (action === 'dashboard') {
      const enrollments = await listEnrollments({ email: user.email }, redis);
      const activeCourses = enrollments.filter((entry) => entry.status === 'active' && entry.course && entry.course.status !== 'archived');
      return res.status(200).json({
        ok: true,
        user: {
          name: user.name,
          email: user.email,
          createdAt: user.createdAt || null,
        },
        courses: activeCourses,
        purchases: Array.isArray(user.purchases) ? user.purchases : [],
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