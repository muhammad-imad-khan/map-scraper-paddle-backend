const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  connect: jest.fn().mockResolvedValue(),
};

const mockDeliverCoursePurchase = jest.fn();

jest.mock('ioredis', () => jest.fn(() => mockRedis));
jest.mock('../lib/helpers', () => ({
  cors: jest.fn(),
  getRedis: jest.fn(() => mockRedis),
  deliverCoursePurchase: (...args) => mockDeliverCoursePurchase(...args),
  BASE_URL: 'https://sandbox-api.paddle.com',
  PADDLE_API_KEY: '',
}));

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

describe('course-deliver API', () => {
  let handler;

  beforeAll(() => {
    handler = require('../api/course-deliver');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
  });

  test('returns success when portal access is granted but email sending fails', async () => {
    mockDeliverCoursePurchase.mockResolvedValue({
      ok: false,
      alreadySent: false,
      portalAccessGranted: true,
      driveShared: true,
      driveError: null,
      error: 'smtp_send_failed',
    });

    const req = {
      method: 'POST',
      body: {
        email: 'buyer@example.com',
        name: 'Buyer',
      },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.portalAccessGranted).toBe(true);
    expect(res.body.portalEmailSent).toBe(false);
    expect(res.body.detail).toBe('smtp_send_failed');
  });

  test('returns 502 when neither portal access nor email delivery succeeds', async () => {
    mockDeliverCoursePurchase.mockResolvedValue({
      ok: false,
      alreadySent: false,
      portalAccessGranted: false,
      driveShared: false,
      driveError: 'share_failed',
      error: 'smtp_send_failed',
    });

    const req = {
      method: 'POST',
      body: {
        email: 'buyer@example.com',
        name: 'Buyer',
      },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/Failed to send course email/i);
    expect(res.body.detail).toBe('smtp_send_failed');
  });
});