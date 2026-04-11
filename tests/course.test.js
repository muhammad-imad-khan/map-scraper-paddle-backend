// ============================================
// TESTS: Course delivery logic (webhook + helpers)
// ============================================
const crypto = require('crypto');

// ── Mock Redis ──
const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  incr: jest.fn().mockResolvedValue(1),
  incrby: jest.fn().mockResolvedValue(100),
  rpush: jest.fn().mockResolvedValue(1),
  del: jest.fn().mockResolvedValue(1),
  connect: jest.fn().mockResolvedValue(),
};
jest.mock('ioredis', () => jest.fn(() => mockRedis));

// ── Mock nodemailer ──
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-123' });
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

// ── Set env vars before requiring modules ──
process.env.PADDLE_ENV = 'sandbox';
process.env.PADDLE_API_KEY = 'test_api_key';
process.env.PADDLE_WEBHOOK_SECRET = 'test_webhook_secret';
process.env.SMTP_USER = 'test@example.com';
process.env.SMTP_PASS = 'test_pass';
process.env.COURSE_LINK = 'https://drive.google.com/drive/folders/test-folder';
process.env.PRICE_COURSE_ID = 'pri_test_course';
process.env.REDIS_URL = 'redis://localhost:6379';

const helpers = require('../lib/helpers');

// ── Helper to build a valid Paddle webhook signature ──
function buildSignature(body, secret) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const payload = `${ts}:${rawBody}`;
  const h1 = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { signature: `ts=${ts};h1=${h1}`, rawBody };
}

// ============================================
// TESTS
// ============================================

describe('PRICE_CREDITS configuration', () => {
  test('should contain a course price entry', () => {
    const courseEntry = Object.entries(helpers.PRICE_CREDITS).find(
      ([, v]) => v.course === true
    );
    expect(courseEntry).toBeDefined();
    expect(courseEntry[1].label).toContain('Course');
    expect(courseEntry[1].credits).toBe(0);
  });

  test('should contain pro and enterprise packs', () => {
    const labels = Object.values(helpers.PRICE_CREDITS).map(v => v.label);
    expect(labels).toContain('Pro Pack');
    expect(labels).toContain('Enterprise Pack');
  });

  test('course entry should not grant unlimited', () => {
    const courseEntry = Object.values(helpers.PRICE_CREDITS).find(v => v.course === true);
    expect(courseEntry.unlimited).toBeUndefined();
  });
});

describe('sendCourseDeliveryEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should send email with Google Drive link', async () => {
    await helpers.sendCourseDeliveryEmail({
      email: 'buyer@example.com',
      name: 'Test Buyer',
      txnId: 'txn_test_123',
    });

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe('buyer@example.com');
    expect(call.subject).toContain('Course Access Is Ready');
    expect(call.html).toContain('drive.google.com');
    expect(call.html).toContain('Test Buyer');
    expect(call.html).toContain('txn_test_123');
  });

  test('should skip if no email provided', async () => {
    await helpers.sendCourseDeliveryEmail({
      email: '',
      name: 'No Email',
      txnId: 'txn_test_456',
    });

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('should include course name in email', async () => {
    await helpers.sendCourseDeliveryEmail({
      email: 'buyer@example.com',
      name: 'Test',
      txnId: 'txn_test_789',
    });

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Lead Generation');
    expect(html).toContain('AI Powered Web Design Course');
  });

  test('email should come from Imad Khan Courses', async () => {
    await helpers.sendCourseDeliveryEmail({
      email: 'buyer@example.com',
      name: 'Test',
      txnId: 'txn_test',
    });

    const from = mockSendMail.mock.calls[0][0].from;
    expect(from).toContain('Imad Khan Courses');
  });
});

describe('Webhook handler — course purchase', () => {
  let handler;

  beforeAll(() => {
    handler = require('../api/webhook');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null); // no dedup
  });

  function buildReq(body, sig) {
    return {
      method: 'POST',
      headers: { 'paddle-signature': sig || '' },
      body,
    };
  }

  function buildRes() {
    const res = {
      statusCode: null,
      body: null,
      setHeader: jest.fn(),
      status: jest.fn(function(code) { res.statusCode = code; return res; }),
      json: jest.fn(function(data) { res.body = data; return res; }),
      end: jest.fn(),
    };
    // CORS headers
    res.setHeader = jest.fn();
    return res;
  }

  test('should reject non-POST requests', async () => {
    const req = { method: 'GET', headers: {} };
    const res = buildRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405); // Method not allowed
  });

  test('should accept transaction.completed with course priceId', async () => {
    const coursePriceId = process.env.PRICE_COURSE_ID;
    const body = {
      event_type: 'transaction.completed',
      data: {
        id: 'txn_course_test_001',
        items: [{ price: { id: coursePriceId }, quantity: 1 }],
        custom_data: { installId: 'test-install-id-12345678', email: 'student@example.com' },
        customer_details: { email: 'student@example.com' },
        details: { totals: { total: '1000' } },
        currency_code: 'USD',
      },
    };

    // Skip signature verification by not setting secret
    const origSecret = process.env.PADDLE_WEBHOOK_SECRET;
    delete process.env.PADDLE_WEBHOOK_SECRET;

    // Mock Redis to return user data
    mockRedis.get.mockImplementation((key) => {
      if (key.startsWith('txn:')) return null; // not a duplicate
      if (key.startsWith('user:')) return JSON.stringify({ name: 'Test Student', purchases: [] });
      if (key.startsWith('credits:')) return '0';
      return null;
    });

    const req = buildReq(body, '');
    const res = buildRes();
    await handler(req, res);

    process.env.PADDLE_WEBHOOK_SECRET = origSecret;

    expect(res.statusCode).toBe(200);
    expect(res.body.received).toBe(true);
  });

  test('should skip non-completed events', async () => {
    const origSecret = process.env.PADDLE_WEBHOOK_SECRET;
    delete process.env.PADDLE_WEBHOOK_SECRET;

    const body = { event_type: 'transaction.created', data: {} };
    const req = buildReq(body, '');
    const res = buildRes();
    await handler(req, res);

    process.env.PADDLE_WEBHOOK_SECRET = origSecret;

    expect(res.statusCode).toBe(200);
    expect(res.body.event).toBe('transaction.created');
  });
});

describe('Utility functions', () => {
  test('isValidInstallId should validate correctly', () => {
    expect(helpers.isValidInstallId('abc12345')).toBe(true);
    expect(helpers.isValidInstallId('a'.repeat(64))).toBe(true);
    expect(helpers.isValidInstallId('short')).toBe(false);
    expect(helpers.isValidInstallId('')).toBe(false);
    expect(helpers.isValidInstallId(null)).toBe(false);
    expect(helpers.isValidInstallId('has spaces!!')).toBe(false);
  });

  test('cors should set CORS headers', () => {
    const res = { setHeader: jest.fn() };
    helpers.cors(res);
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', expect.stringContaining('POST'));
  });
});
