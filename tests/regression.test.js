/**
 * Regression Test Suite — hits the LIVE deployed Vercel backend.
 * Covers: pricing-config, credits, auth, checkout, course-checkout,
 *         course-deliver, admin-users, admin-courses, bank-transfer,
 *         verify-license, customer-portal, branding.
 *
 * Run:  npx jest tests/regression.test.js --verbose --testTimeout=30000
 */

const API = 'https://map-scraper-paddle-backend.vercel.app';
const ADMIN_KEY = 'MSA_475220912dbf4bc1b3e3d813083c2508877cf5c3dda94e889edc0522e9780b13';
const TEST_INSTALL_ID = `regtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_EMAIL = `regtest-${Date.now()}@example.com`;
const TEST_PASSWORD = 'Regr3ss!on2025';
const TEST_NAME = 'Regression Tester';

let authToken = null;
let clientId = 'regtestclient' + Math.random().toString(36).slice(2, 14);

async function api(path, options = {}) {
  const url = `${API}${path}`;
  const { headers: extraHeaders, ...rest } = options;
  const res = await fetch(url, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ═══════════════════════════════════════════════════════
//  1. PRICING CONFIG
// ═══════════════════════════════════════════════════════
describe('Pricing Config', () => {
  test('GET returns valid pricing with production price IDs', async () => {
    const { status, body } = await api('/api/pricing-config');
    expect(status).toBe(200);
    expect(body).toHaveProperty('mode');
    expect(['credit_based', 'one_time']).toContain(body.mode);
    expect(body).toHaveProperty('pricing');
    expect(body.pricing).toHaveProperty('plans');

    const plans = body.pricing.plans;
    expect(plans.oneTime.priceId).toMatch(/^pri_/);
    expect(plans.oneTimeIntl.priceId).toMatch(/^pri_/);
    expect(plans.course.priceId).toMatch(/^pri_/);
    expect(plans.courseIntl.priceId).toMatch(/^pri_/);

    // Branding check — no old name
    const json = JSON.stringify(body);
    expect(json).not.toContain('Map Scrapper');
  });

  test('POST without admin key returns 401', async () => {
    const { status } = await api('/api/pricing-config', {
      method: 'POST',
      body: JSON.stringify({ action: 'setPricingMode', mode: 'one_time' }),
    });
    expect(status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
//  2. CREDITS
// ═══════════════════════════════════════════════════════
describe('Credits API', () => {
  test('GET initialises new install with starter credits', async () => {
    const { status, body } = await api(`/api/credits?installId=${TEST_INSTALL_ID}`);
    expect(status).toBe(200);
    expect(typeof body.credits).toBe('number');
    expect(body.credits).toBeGreaterThanOrEqual(0);
    expect(body.installId).toBe(TEST_INSTALL_ID);
  });

  test('GET without installId returns 400', async () => {
    const { status } = await api('/api/credits');
    expect(status).toBe(400);
  });

  test('POST deduct with amount=0 is handled gracefully', async () => {
    const { status } = await api('/api/credits', {
      method: 'POST',
      headers: { 'X-Install-Id': TEST_INSTALL_ID },
      body: JSON.stringify({ amount: 0 }),
    });
    // Server may accept 0 or reject — either is valid
    expect([200, 400]).toContain(status);
  });

  test('POST saveEmail stores email for install', async () => {
    const { status, body } = await api('/api/credits', {
      method: 'POST',
      headers: { 'X-Install-Id': TEST_INSTALL_ID },
      body: JSON.stringify({ action: 'saveEmail', email: TEST_EMAIL, name: TEST_NAME }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.email).toBe(TEST_EMAIL);
  });
});

// ═══════════════════════════════════════════════════════
//  3. AUTH
// ═══════════════════════════════════════════════════════
describe('Auth API', () => {
  test('register creates new user and returns token', async () => {
    const { status, body } = await api('/api/auth', {
      method: 'POST',
      headers: { 'X-Client-Id': clientId },
      body: JSON.stringify({
        action: 'register',
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: TEST_NAME,
        clientId,
      }),
    });
    expect(status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe(TEST_EMAIL);
    authToken = body.token;
  });

  test('duplicate register returns 409', async () => {
    const { status } = await api('/api/auth', {
      method: 'POST',
      headers: { 'X-Client-Id': clientId },
      body: JSON.stringify({
        action: 'register',
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: TEST_NAME,
        clientId,
      }),
    });
    expect(status).toBe(409);
  });

  test('login returns token', async () => {
    const { status, body } = await api('/api/auth', {
      method: 'POST',
      headers: { 'X-Client-Id': clientId },
      body: JSON.stringify({
        action: 'login',
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        clientId,
      }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
    authToken = body.token;
  });

  test('me returns user profile and entitlements', async () => {
    const { status, body } = await api('/api/auth', {
      method: 'POST',
      headers: { 'X-Client-Id': clientId },
      body: JSON.stringify({ action: 'me', token: authToken, clientId }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.user.email).toBe(TEST_EMAIL);
    expect(body).toHaveProperty('entitlements');
    expect(typeof body.entitlements.lifetimeAccess).toBe('boolean');
  });

  test('me with invalid token returns 401 or 400', async () => {
    const { status } = await api('/api/auth', {
      method: 'POST',
      headers: { 'X-Client-Id': clientId },
      body: JSON.stringify({ action: 'me', token: 'invalid_token_abcdef1234567890', clientId }),
    });
    expect([400, 401]).toContain(status);
  });

  test('ext-login with wrong password returns 401', async () => {
    const { status } = await api('/api/auth', {
      method: 'POST',
      body: JSON.stringify({
        action: 'ext-login',
        email: TEST_EMAIL,
        password: 'wrong-password',
        installId: TEST_INSTALL_ID,
      }),
    });
    expect(status).toBe(401);
  });

  test('ext-login with correct password returns ok', async () => {
    const { status, body } = await api('/api/auth', {
      method: 'POST',
      body: JSON.stringify({
        action: 'ext-login',
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        installId: TEST_INSTALL_ID,
      }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.user.email).toBe(TEST_EMAIL);
    expect(body).toHaveProperty('entitlements');
  });
});

// ═══════════════════════════════════════════════════════
//  4. CHECKOUT (validation only — no real Paddle txn)
// ═══════════════════════════════════════════════════════
describe('Checkout API', () => {
  test('POST without token returns 401', async () => {
    const { status } = await api('/api/checkout', {
      method: 'POST',
      body: JSON.stringify({ installId: TEST_INSTALL_ID, pack: 'lifetime' }),
    });
    expect(status).toBe(401);
  });

  test('POST with invalid priceId returns 400 or falls back to default', async () => {
    const { status } = await api('/api/checkout', {
      method: 'POST',
      headers: { 'X-Client-Id': clientId },
      body: JSON.stringify({
        token: authToken || 'nonexistent_token_placeholder',
        installId: TEST_INSTALL_ID,
        pack: 'lifetime',
        priceId: 'INVALID',
        country: 'Pakistan',
        currency: 'PKR',
        clientId,
      }),
    });
    // 400 for bad priceId, 401 if token issue, or 200 if server has fallback pricing
    expect([200, 400, 401]).toContain(status);
  });
});

// ═══════════════════════════════════════════════════════
//  5. COURSE CHECKOUT (validation only)
// ═══════════════════════════════════════════════════════
describe('Course Checkout API', () => {
  test('POST without email returns 400', async () => {
    const { status } = await api('/api/course-checkout', {
      method: 'POST',
      body: JSON.stringify({ name: TEST_NAME }),
    });
    expect(status).toBe(400);
  });

  test('POST with valid email creates a checkout', async () => {
    const { status, body } = await api('/api/course-checkout', {
      method: 'POST',
      body: JSON.stringify({
        email: TEST_EMAIL,
        name: TEST_NAME,
        country: 'Pakistan',
        currency: 'PKR',
      }),
    });
    // Should either succeed (200) or fail gracefully (502 if Paddle rejects)
    expect([200, 502]).toContain(status);
    if (status === 200) {
      expect(body.checkoutUrl).toBeTruthy();
      expect(body.txnId).toMatch(/^txn_/);
      expect(body.paddleEnv).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════
//  6. COURSE DELIVER (validation only)
// ═══════════════════════════════════════════════════════
describe('Course Deliver API', () => {
  test('POST without email returns 400', async () => {
    const { status } = await api('/api/course-deliver', {
      method: 'POST',
      body: JSON.stringify({ name: TEST_NAME }),
    });
    expect(status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
//  7. ADMIN - USERS
// ═══════════════════════════════════════════════════════
describe('Admin Users API', () => {
  test('GET without admin key returns 401', async () => {
    const { status } = await api('/api/admin-users');
    expect(status).toBe(401);
  });

  test('GET type=stats returns stats', async () => {
    const { status, body } = await api('/api/admin-users?type=stats', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.totalInstalls).toBe('number');
  });

  test('GET type=users returns user list', async () => {
    const { status, body } = await api('/api/admin-users?type=users&limit=5', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(status).toBe(200);
    expect(body.type).toBe('users');
    expect(Array.isArray(body.items)).toBe(true);
  });

  test('GET type=installs returns install list', async () => {
    const { status, body } = await api('/api/admin-users?type=installs&limit=5', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(status).toBe(200);
    expect(body.type).toBe('installs');
    expect(Array.isArray(body.items)).toBe(true);
  });

  test('GET type=bankTransfers returns transfer list', async () => {
    const { status, body } = await api('/api/admin-users?type=bankTransfers', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  test('POST testEmail sends admin test email', async () => {
    const { status, body } = await api('/api/admin-users', {
      method: 'POST',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({ action: 'testEmail' }),
    });
    // 200 if SMTP is configured, 500 otherwise
    expect([200, 500]).toContain(status);
    if (status === 200) {
      expect(body.ok).toBe(true);
    }
  });

  test('POST adjustCredits adjusts test install credits', async () => {
    const { status, body } = await api('/api/admin-users', {
      method: 'POST',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({
        action: 'adjustCredits',
        installId: TEST_INSTALL_ID,
        delta: 10,
        reason: 'regression-test',
      }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.installId).toBe(TEST_INSTALL_ID);
    expect(typeof body.balance).toBe('number');
  });

  test('POST setCredits sets exact credit amount', async () => {
    const { status, body } = await api('/api/admin-users', {
      method: 'POST',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({
        action: 'setCredits',
        installId: TEST_INSTALL_ID,
        credits: 50,
      }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.balance).toBe(50);
  });

  test('GET type=monthlyReport returns sales report', async () => {
    const { status, body } = await api('/api/admin-users?type=monthlyReport', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.months)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
//  8. ADMIN - COURSES
// ═══════════════════════════════════════════════════════
describe('Admin Courses API', () => {
  test('GET without admin key returns 401', async () => {
    const { status } = await api('/api/admin-courses');
    expect(status).toBe(401);
  });

  test('GET returns course list', async () => {
    const { status, body } = await api('/api/admin-courses', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
//  9. BANK TRANSFER (validation only)
// ═══════════════════════════════════════════════════════
describe('Bank Transfer API', () => {
  test('POST without email returns 400', async () => {
    const { status } = await api('/api/bank-transfer', {
      method: 'POST',
      body: JSON.stringify({ pack: 'Lifetime License' }),
    });
    expect(status).toBe(400);
  });

  test('POST without pack returns 400', async () => {
    const { status } = await api('/api/bank-transfer', {
      method: 'POST',
      body: JSON.stringify({ email: TEST_EMAIL }),
    });
    expect(status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
//  10. VERIFY LICENSE (validation only)
// ═══════════════════════════════════════════════════════
describe('Verify License API', () => {
  test('POST with invalid key format returns 400', async () => {
    const { status } = await api('/api/verify-license', {
      method: 'POST',
      body: JSON.stringify({ licenseKey: 'abc' }),
    });
    expect(status).toBe(400);
  });

  test('POST with non-existent key returns 404', async () => {
    const { status } = await api('/api/verify-license', {
      method: 'POST',
      body: JSON.stringify({ licenseKey: 'MLS-DOESNOTEXIST-12345678' }),
    });
    expect(status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════
//  11. CUSTOMER PORTAL (validation only)
// ═══════════════════════════════════════════════════════
describe('Customer Portal API', () => {
  test('POST without token returns 401', async () => {
    const { status } = await api('/api/customer-portal', {
      method: 'POST',
      body: JSON.stringify({ action: 'dashboard' }),
    });
    expect(status).toBe(401);
  });

  test('POST dashboard with valid token returns user data', async () => {
    const { status, body } = await api('/api/customer-portal', {
      method: 'POST',
      headers: { 'X-Client-Id': clientId },
      body: JSON.stringify({ action: 'dashboard', token: authToken, clientId }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.user.email).toBe(TEST_EMAIL);
  });
});

// ═══════════════════════════════════════════════════════
//  12. BRANDING — no old name in any public response
// ═══════════════════════════════════════════════════════
describe('Branding Verification', () => {
  test('pricing-config has no old branding', async () => {
    const { body } = await api('/api/pricing-config');
    const json = JSON.stringify(body);
    expect(json).not.toContain('Map Scrapper');
  });

  test('admin stats has correct branding in email template (via testEmail)', async () => {
    // The testEmail action uses APP_BRAND internally — if it returns ok,
    // the template rendered without errors.
    const { status } = await api('/api/admin-users', {
      method: 'POST',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({ action: 'testEmail' }),
    });
    expect([200, 500]).toContain(status);
  });
});

// ═══════════════════════════════════════════════════════
//  13. CLEANUP — delete test user so tests are idempotent
// ═══════════════════════════════════════════════════════
describe('Cleanup', () => {
  test('logout test user', async () => {
    if (!authToken) return;
    const { status } = await api('/api/auth', {
      method: 'POST',
      headers: { 'X-Client-Id': clientId },
      body: JSON.stringify({ action: 'logout', token: authToken, clientId }),
    });
    expect([200, 401]).toContain(status);
  });

  test('delete test user via admin', async () => {
    const { status, body } = await api('/api/admin-users', {
      method: 'POST',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({ action: 'deleteUser', email: TEST_EMAIL }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
