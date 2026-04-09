const mockRedis = {
  get: jest.fn(),
  set: jest.fn().mockResolvedValue('OK'),
  incr: jest.fn().mockResolvedValue(1),
  incrby: jest.fn().mockResolvedValue(1),
  rpush: jest.fn().mockResolvedValue(1),
  del: jest.fn().mockResolvedValue(1),
  eval: jest.fn().mockResolvedValue(0),
  connect: jest.fn().mockResolvedValue(),
};

jest.mock('ioredis', () => jest.fn(() => mockRedis));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
}

function setBaseEnv(overrides = {}) {
  restoreEnv();
  Object.assign(process.env, {
    PADDLE_ENV: 'sandbox',
    PADDLE_API_KEY: 'test_api_key',
    REDIS_URL: 'redis://localhost:6379',
    PRICE_ONE_TIME_ID: 'pri_test_tool_pk',
    PRICE_ONE_TIME_INTL_ID: 'pri_test_tool_intl',
    PRICE_COURSE_ID: 'pri_test_course',
    PRICE_COURSE_INTL_ID: 'pri_test_course_intl',
    ...overrides,
  });
}

function loadCheckoutHandler(overrides = {}) {
  jest.resetModules();
  setBaseEnv(overrides);
  return require('../api/checkout');
}

function loadAuthHandler(overrides = {}) {
  jest.resetModules();
  setBaseEnv(overrides);
  return require('../api/auth');
}

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    setHeader: jest.fn(),
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end: jest.fn(),
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
  mockRedis.get.mockImplementation(async (key) => {
    if (key === 'session:test_token') {
      return JSON.stringify({ email: 'buyer@example.com' });
    }
    if (key === 'user:buyer@example.com') {
      return JSON.stringify({ email: 'buyer@example.com', purchases: [] });
    }
    return null;
  });
});

afterAll(() => {
  restoreEnv();
  global.fetch = ORIGINAL_FETCH;
});

describe('Tool checkout price routing', () => {
  test('never retries the course price for lifetime tool checkout', async () => {
    const handler = loadCheckoutHandler({
      PRICE_CHECKOUT_FALLBACK_ID: 'pri_test_course',
    });

    global.fetch.mockImplementation(async (url, options) => {
      const body = JSON.parse(options.body);
      return {
        json: async () => ({
          error: { detail: `rejected:${body.items[0].price_id}` },
        }),
      };
    });

    const req = {
      method: 'POST',
      headers: {},
      body: {
        token: 'test_token',
        installId: 'test-install-1234',
        pack: 'lifetime',
        country: 'Pakistan',
        currency: 'PKR',
        priceId: 'pri_test_tool_pk',
      },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(502);
    expect(res.body.triedPriceIds).toEqual(['pri_test_tool_pk', 'pri_test_tool_intl']);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const requestedPriceIds = global.fetch.mock.calls.map(([, options]) => {
      const body = JSON.parse(options.body);
      return body.items[0].price_id;
    });
    expect(requestedPriceIds).toEqual(['pri_test_tool_pk', 'pri_test_tool_intl']);
    expect(requestedPriceIds).not.toContain('pri_test_course');
  });

  test('rejects lifetime checkout when tool prices are misconfigured to course products', async () => {
    const handler = loadCheckoutHandler({
      PRICE_ONE_TIME_ID: 'pri_test_course',
      PRICE_ONE_TIME_INTL_ID: 'pri_test_course_intl',
      PRICE_CHECKOUT_FALLBACK_ID: 'pri_test_course',
    });

    const req = {
      method: 'POST',
      headers: {},
      body: {
        token: 'test_token',
        installId: 'test-install-1234',
        pack: 'lifetime',
        country: 'Pakistan',
        currency: 'PKR',
        priceId: 'pri_test_course',
      },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/missing or invalid priceId/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('Auth entitlements', () => {
  test('does not treat a course purchase as lifetime tool access', async () => {
    const handler = loadAuthHandler({
      PRICE_CHECKOUT_FALLBACK_ID: 'pri_test_course',
    });

    mockRedis.get.mockImplementation(async (key) => {
      if (key === 'session:test_token') {
        return JSON.stringify({ email: 'buyer@example.com' });
      }
      if (key === 'user:buyer@example.com') {
        return JSON.stringify({
          email: 'buyer@example.com',
          purchases: [
            {
              status: 'completed',
              priceId: 'pri_test_course',
              label: 'Lead Gen x AI Web Design Course',
            },
          ],
        });
      }
      return null;
    });

    const req = {
      method: 'POST',
      headers: {},
      body: {
        action: 'me',
        token: 'test_token',
      },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.entitlements.lifetimeAccess).toBe(false);
    expect(res.body.entitlements.zipDownload).toBe(false);
  });
});