// POST /api/bank-transfer
// Creates a bank transfer request record and notifies admin.
// Supports both credit-pack and course purchases.
// Body: { pack, email, name, installId, reference, purchaseType, courseId, receiptDataUrl, receiptName, receiptMimeType }
const { cors, getRedis, sendPurchaseNotification, ADMIN_EMAIL } = require('./_helpers');
const nodemailer = require('nodemailer');

function getMailTransport() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    pack,
    email,
    name,
    installId,
    reference,
    purchaseType,
    courseId,
    receiptDataUrl,
    receiptName,
    receiptMimeType,
    amount,
    currency,
  } = req.body || {};

  if (!pack || !email) {
    return res.status(400).json({ error: 'Missing pack or email.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  try {
    const redis = getRedis();
    const id = 'bt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    const record = {
      id,
      pack,
      email: email.trim().toLowerCase(),
      name: (name || '').trim(),
      installId: installId || null,
      reference: reference || null,
      purchaseType: purchaseType === 'course' ? 'course' : 'credits',
      courseId: courseId || null,
      receiptDataUrl: typeof receiptDataUrl === 'string' ? receiptDataUrl.slice(0, 2_000_000) : null,
      receiptName: typeof receiptName === 'string' ? receiptName.slice(0, 180) : null,
      receiptMimeType: typeof receiptMimeType === 'string' ? receiptMimeType.slice(0, 120) : null,
      amount: amount || null,
      currency: currency || null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      approvedAt: null,
      approvedBy: null,
    };

    // Store in Redis list
    await redis.set(`banktransfer:${id}`, JSON.stringify(record));
    // Add to index for scanning
    await redis.lpush('banktransfers:pending', id);

    // Send admin notification email
    const transport = getMailTransport();
    if (transport) {
      const html = `
        <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
          <div style="background:#d97706;padding:20px 24px;color:#fff;">
            <h2 style="margin:0;font-size:20px;">Bank Transfer Request</h2>
          </div>
          <div style="padding:24px;">
            <p style="font-size:14px;color:#334155;margin:0 0 16px;">A user has completed a bank transfer and is waiting for credit approval.</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr><td style="padding:8px 0;color:#64748b;width:130px;">Customer</td><td style="padding:8px 0;font-weight:600;">${record.name || 'N/A'}</td></tr>
              <tr><td style="padding:8px 0;color:#64748b;">Email</td><td style="padding:8px 0;">${record.email}</td></tr>
              <tr><td style="padding:8px 0;color:#64748b;">Type</td><td style="padding:8px 0;font-weight:600;">${record.purchaseType === 'course' ? 'Course access' : 'Credit pack'}</td></tr>
              <tr><td style="padding:8px 0;color:#64748b;">Pack</td><td style="padding:8px 0;font-weight:600;">${record.pack}</td></tr>
              <tr><td style="padding:8px 0;color:#64748b;">Reference</td><td style="padding:8px 0;">${record.reference || 'N/A'}</td></tr>
              <tr><td style="padding:8px 0;color:#64748b;">Receipt</td><td style="padding:8px 0;">${record.receiptName || 'Not attached'}</td></tr>
              <tr><td style="padding:8px 0;color:#64748b;">Request ID</td><td style="padding:8px 0;font-size:12px;">${id}</td></tr>
              <tr><td style="padding:8px 0;color:#64748b;">Date</td><td style="padding:8px 0;">${record.createdAt}</td></tr>
            </table>
            <div style="margin-top:20px;text-align:center;">
              <a href="https://map-scrapper-five.vercel.app/admin/${record.purchaseType === 'course' ? 'courses.html' : ''}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Open Admin Panel</a>
            </div>
          </div>
          <div style="background:#f8fafc;padding:14px 24px;font-size:12px;color:#94a3b8;text-align:center;">
            Map Lead Scraper &mdash; Bank Transfer Request
          </div>
        </div>
      `;
      transport.sendMail({
        from: `"Map Lead Scraper" <${process.env.SMTP_USER}>`,
        to: ADMIN_EMAIL,
        subject: `Bank Transfer Request: ${record.pack} by ${record.email}`,
        html,
      }).catch(err => console.error('Failed to send bank transfer notification:', err.message));
    }

    return res.status(200).json({
      ok: true,
      id,
      message: record.purchaseType === 'course'
        ? 'Transfer recorded. Admin will verify your receipt and activate your course portal access.'
        : 'Transfer recorded. Admin will verify and activate your credits.',
    });
  } catch (err) {
    console.error('bank-transfer error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
