const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  lrange: jest.fn().mockResolvedValue([]),
};

const mockGetCredits = jest.fn();
const mockInitUser = jest.fn();
const mockDeductCredits = jest.fn();
const mockSendInstallNotification = jest.fn();
const mockSendLowCreditsEmail = jest.fn();
const mockGetInstallEntitlement = jest.fn();

jest.mock('../lib/helpers', () => ({
  cors: jest.fn(),
  isValidInstallId: jest.fn(() => true),
  getCredits: (...args) => mockGetCredits(...args),
  initUser: (...args) => mockInitUser(...args),
  deductCredits: (...args) => mockDeductCredits(...args),
  sendInstallNotification: (...args) => mockSendInstallNotification(...args),
  sendLowCreditsEmail: (...args) => mockSendLowCreditsEmail(...args),
  getRedis: jest.fn(() => mockRedis),
  keys: {
    install: (id) => `install:${id}`,
    txnLog: (id) => `txnlog:${id}`,
  },
  LOW_CREDITS_THRESHOLD: 5,
  getInstallEntitlement: (...args) => mockGetInstallEntitlement(...args),
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

describe('credits API unlimited installs', () => {
  let handler;

  beforeAll(() => {
    handler = require('../api/credits');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockInitUser.mockResolvedValue({ credits: 3, expired: false, expiresAt: null, isNew: false });
    mockGetCredits.mockResolvedValue({ credits: 3, expired: false, expiresAt: null });
    mockGetInstallEntitlement.mockResolvedValue({ unlimited: false });
  });

  test('GET returns unlimited access even if numeric credits look expired', async () => {
    mockInitUser.mockResolvedValue({ credits: 0, expired: true, expiresAt: 1712345678901, isNew: false });
    mockGetInstallEntitlement.mockResolvedValue({ unlimited: true });

    const req = {
      method: 'GET',
      headers: { 'x-install-id': 'install_test_1234' },
      query: { installId: 'install_test_1234' },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      credits: 0,
      installId: 'install_test_1234',
      expired: false,
      expiresAt: null,
      unlimited: true,
    }));
  });

  test('POST skips deduction when lifetime access is active', async () => {
    mockGetCredits.mockResolvedValue({ credits: 0, expired: false, expiresAt: null });
    mockGetInstallEntitlement.mockResolvedValue({ unlimited: true });

    const req = {
      method: 'POST',
      headers: { 'x-install-id': 'install_test_1234' },
      query: {},
      body: { amount: 1 },
    };
    const res = createRes();

    await handler(req, res);

    expect(mockDeductCredits).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      credits: 0,
      deducted: 0,
      expiresAt: null,
      unlimited: true,
    }));
  });
});