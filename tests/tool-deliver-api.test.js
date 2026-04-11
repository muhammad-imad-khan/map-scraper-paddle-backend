const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  connect: jest.fn().mockResolvedValue(),
};

const mockDeliverToolPurchase = jest.fn();

jest.mock('ioredis', () => jest.fn(() => mockRedis));
jest.mock('../lib/helpers', () => ({
  cors: jest.fn(),
  paddleRequest: jest.fn(),
  BASE_URL: 'https://sandbox-api.paddle.com',
  PADDLE_API_KEY: '',
  PADDLE_ENV: 'sandbox',
  isValidInstallId: jest.fn(() => true),
  initUser: jest.fn(),
  getRedis: jest.fn(() => mockRedis),
  FRONTEND_URL: 'https://lead-genx.vercel.app',
  PRICE_IDS: {
    course: 'pri_test_course',
    courseIntl: 'pri_test_course_intl',
  },
  PRICE_CREDITS: {
    pri_test_tool: { credits: 0, label: 'Lifetime License', unlimited: true },
  },
  deliverToolPurchase: (...args) => mockDeliverToolPurchase(...args),
  safeParse: (value, fallback = null) => {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  },
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

describe('tool-deliver API', () => {
  let handler;

  beforeAll(() => {
    handler = require('../api/checkout');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.get.mockImplementation(async (key) => {
      if (key === 'session:test_token') {
        return JSON.stringify({ email: 'buyer@example.com' });
      }
      if (key === 'user:buyer@example.com') {
        return JSON.stringify({
          email: 'buyer@example.com',
          name: 'Buyer',
          purchases: [{
            txnId: 'txn_test_tool',
            priceId: 'pri_test_tool',
            installId: 'install_test_1234',
            status: 'pending',
          }],
        });
      }
      return null;
    });
  });

  test('returns success when entitlement is granted but zip email fails', async () => {
    mockDeliverToolPurchase.mockResolvedValue({
      ok: false,
      entitlementGranted: true,
      zipEmailSent: false,
      error: 'smtp_send_failed',
    });

    const req = {
      method: 'POST',
      headers: {},
      body: {
        action: 'deliverToolPurchase',
        token: 'test_token',
        clientId: 'client_1234567890abcd',
        txnId: 'txn_test_tool',
        installId: 'install_test_1234',
      },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entitlementGranted).toBe(true);
    expect(res.body.zipEmailSent).toBe(false);
    expect(res.body.detail).toBe('smtp_send_failed');
  });

  test('returns success when tool purchase is finalized and zip email is sent', async () => {
    mockDeliverToolPurchase.mockResolvedValue({
      ok: true,
      entitlementGranted: true,
      zipEmailSent: true,
      provider: 'smtp',
      txnId: 'txn_test_tool',
    });

    const req = {
      method: 'POST',
      headers: {},
      body: {
        action: 'deliverToolPurchase',
        token: 'test_token',
        clientId: 'client_1234567890abcd',
        txnId: 'txn_test_tool',
        installId: 'install_test_1234',
      },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entitlementGranted).toBe(true);
    expect(res.body.zipEmailSent).toBe(true);
    expect(res.body.deliveryProvider).toBe('smtp');
  });
});