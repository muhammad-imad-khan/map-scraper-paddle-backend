// ═══════════════════════════════════════════════════════════════
//  Maps Lead Scraper — Payment Flow Tests
//  Node built-in test runner with mocked Paddle API
//  Run: npm test
// ═══════════════════════════════════════════════════════════════

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

// ── Test env vars (BEFORE importing server) ──────────────────
process.env.PADDLE_API_KEY        = 'test_api_key_123';
process.env.PADDLE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.PADDLE_ENV            = 'sandbox';
process.env.PRICE_ID_100          = 'pri_test_100';
process.env.PRICE_ID_500          = 'pri_test_500';
process.env.PRICE_ID_1000         = 'pri_test_1000';
process.env.SITE_ORIGIN           = 'http://localhost:5500';
process.env.SUCCESS_URL           = 'http://localhost:5500/success';
process.env.PAYMENT_CHECKOUT_URL  = 'http://localhost:5500/checkout';
process.env.PORT                  = '0';

// ── Mock global fetch (intercepts Paddle API calls) ──────────
const originalFetch = globalThis.fetch;
let mockFetchResponse = {};

globalThis.fetch = async (url, options) => {
  // Only mock Paddle API calls, let localhost requests through
  if (typeof url === 'string' && url.includes('paddle.com')) {
    mockFetchResponse._lastRequest = {
      url,
      options,
      body: options?.body ? JSON.parse(options.body) : null,
    };
    return {
      ok:     mockFetchResponse.ok ?? true,
      status: mockFetchResponse.status ?? 200,
      json:   async () => mockFetchResponse.data ?? {},
    };
  }
  return originalFetch(url, options);
};

// ── Import server AFTER env + fetch are set ──────────────────
const { default: app } = await import('../server.js');

let server, baseUrl;

// ── Helpers ──────────────────────────────────────────────────
async function api(path, options = {}) {
  const res = await originalFetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json();
  return { status: res.status, body };
}

function signWebhook(payload, secret) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${payload}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

async function sendWebhook(payload) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const sig = signWebhook(raw, process.env.PADDLE_WEBHOOK_SECRET);
  const res = await originalFetch(`${baseUrl}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'paddle-signature': sig },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

// ── Setup / Teardown ─────────────────────────────────────────
before((_, done) => {
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

after((_, done) => { server.close(done); });

beforeEach(() => { mockFetchResponse = {}; });

// ═══════════════════════════════════════════════════════════════
//  1. BASIC ENDPOINTS
// ═══════════════════════════════════════════════════════════════
describe('Basic endpoints', () => {
  it('GET / — returns API info with all routes', async () => {
    const { status, body } = await api('/');
    assert.equal(status, 200);
    assert.equal(body.name, 'Maps Lead Scraper API');
    assert.equal(body.version, '2.0.0');
    assert.equal(body.env, 'sandbox');
    assert.ok(body.routes.includes('/api/checkout'));
    assert.ok(body.routes.includes('/api/webhook'));
    assert.ok(body.routes.includes('/api/verify-license'));
  });

  it('GET /api/health — returns ok', async () => {
    const { status, body } = await api('/api/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.env, 'sandbox');
    assert.equal(body.checkoutConfigured, true);
  });

  it('GET /api/packs — returns all 3 credit packs', async () => {
    const { status, body } = await api('/api/packs');
    assert.equal(status, 200);
    assert.equal(body.packs.length, 3);

    const starter = body.packs.find(p => p.credits === 100);
    const pro     = body.packs.find(p => p.credits === 500);
    const agency  = body.packs.find(p => p.credits === 1000);

    assert.ok(starter && pro && agency, 'All 3 packs must be present');
    assert.equal(starter.priceId, 'pri_test_100');
    assert.equal(starter.price,   '$5');
    assert.equal(pro.priceId,     'pri_test_500');
    assert.equal(pro.price,       '$19');
    assert.equal(agency.priceId,  'pri_test_1000');
    assert.equal(agency.price,    '$35');
  });

  it('GET /api/payment-config — returns checkout URL', async () => {
    const { status, body } = await api('/api/payment-config');
    assert.equal(status, 200);
    assert.equal(body.checkoutUrl, 'http://localhost:5500/checkout');
  });
});

// ═══════════════════════════════════════════════════════════════
//  2. CHECKOUT — MOCK PAYMENT FOR ALL 3 PLANS
// ═══════════════════════════════════════════════════════════════
describe('Checkout — mock Paddle checkout for all 3 plans', () => {

  const plans = [
    { label: 'Starter Pack', priceId: 'pri_test_100',  credits: 100,  price: '$5'  },
    { label: 'Pro Pack',     priceId: 'pri_test_500',  credits: 500,  price: '$19' },
    { label: 'Agency Pack',  priceId: 'pri_test_1000', credits: 1000, price: '$35' },
  ];

  for (const plan of plans) {
    it(`✅ ${plan.label} (${plan.credits} credits / ${plan.price}) — creates checkout URL`, async () => {
      mockFetchResponse = {
        ok: true, status: 200,
        data: {
          data: {
            id: `txn_${plan.credits}`,
            checkout: { url: `https://checkout.paddle.com/pay?txn=txn_${plan.credits}` },
          },
        },
      };

      const { status, body } = await api('/api/checkout', {
        method: 'POST',
        body: JSON.stringify({ priceId: plan.priceId }),
      });

      assert.equal(status, 200, `Expected 200 for ${plan.label}`);
      assert.ok(body.checkoutUrl, `No checkoutUrl for ${plan.label}`);
      assert.ok(body.checkoutUrl.includes(`txn_${plan.credits}`));

      // Verify what was sent to Paddle
      const sent = mockFetchResponse._lastRequest;
      assert.ok(sent.url.includes('sandbox-api.paddle.com/transactions'));
      assert.equal(sent.body.items[0].price_id, plan.priceId);
      assert.equal(sent.body.items[0].quantity, 1);
      assert.equal(sent.body.custom_data.priceId, plan.priceId);
    });
  }

  it('❌ rejects missing priceId', async () => {
    const { status, body } = await api('/api/checkout', {
      method: 'POST', body: JSON.stringify({}),
    });
    assert.equal(status, 400);
    assert.match(body.error, /missing/i);
  });

  it('❌ rejects unknown priceId', async () => {
    const { status, body } = await api('/api/checkout', {
      method: 'POST', body: JSON.stringify({ priceId: 'pri_fake_999' }),
    });
    assert.equal(status, 400);
    assert.match(body.error, /invalid/i);
    assert.equal(body.provided, 'pri_fake_999');
  });

  it('❌ handles Paddle API error with helpful hint', async () => {
    mockFetchResponse = {
      ok: false, status: 400,
      data: { error: { code: 'transaction_checkout_not_enabled', detail: 'Checkout not enabled' } },
    };

    const { status, body } = await api('/api/checkout', {
      method: 'POST', body: JSON.stringify({ priceId: 'pri_test_100' }),
    });
    assert.equal(status, 500);
    assert.ok(body.error.includes('Paddle'));
    assert.ok(body.fix.includes('Contact Paddle'));
  });

  it('❌ handles missing checkout URL in Paddle response', async () => {
    mockFetchResponse = { ok: true, status: 200, data: { data: { id: 'txn_no_url' } } };

    const { status, body } = await api('/api/checkout', {
      method: 'POST', body: JSON.stringify({ priceId: 'pri_test_100' }),
    });
    assert.equal(status, 500);
    assert.match(body.error, /no checkout url/i);
    assert.ok(body.fix);
  });
});

// ═══════════════════════════════════════════════════════════════
//  3. WEBHOOK — PAYMENT COMPLETED FOR ALL 3 PLANS
// ═══════════════════════════════════════════════════════════════
describe('Webhook — transaction.completed for all 3 plans', () => {

  const plans = [
    { priceId: 'pri_test_100',  credits: 100,  label: 'Starter Pack' },
    { priceId: 'pri_test_500',  credits: 500,  label: 'Pro Pack'     },
    { priceId: 'pri_test_1000', credits: 1000, label: 'Agency Pack'  },
  ];

  for (const plan of plans) {
    it(`✅ ${plan.label} — generates license key on payment (${plan.credits} credits)`, async () => {
      const licensesBefore = (await api('/api/health')).body.licenses;

      const { status, body } = await sendWebhook({
        event_type: 'transaction.completed',
        data: {
          id: `txn_wh_${plan.credits}_${Date.now()}`,
          custom_data: { priceId: plan.priceId },
          customer: { email: `buyer-${plan.credits}@test.com` },
          items: [{ price: { id: plan.priceId } }],
        },
      });

      assert.equal(status, 200);
      assert.equal(body.ok, true);

      const licensesAfter = (await api('/api/health')).body.licenses;
      assert.equal(licensesAfter, licensesBefore + 1, `License count should increase by 1 for ${plan.label}`);
    });
  }

  it('❌ rejects invalid webhook signature', async () => {
    const payload = JSON.stringify({
      event_type: 'transaction.completed',
      data: { id: 'txn_bad', custom_data: { priceId: 'pri_test_100' }, items: [] },
    });

    const res = await originalFetch(`${baseUrl}/api/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'paddle-signature': 'ts=1;h1=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: payload,
    });
    assert.equal(res.status, 401);
  });

  it('ignores non-transaction.completed events', async () => {
    const licensesBefore = (await api('/api/health')).body.licenses;

    const { status, body } = await sendWebhook({
      event_type: 'transaction.created',
      data: { id: 'txn_created', custom_data: {}, items: [] },
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const licensesAfter = (await api('/api/health')).body.licenses;
    assert.equal(licensesAfter, licensesBefore, 'No new license for non-completed events');
  });
});

// ═══════════════════════════════════════════════════════════════
//  4. LICENSE VERIFICATION
// ═══════════════════════════════════════════════════════════════
describe('License verification', () => {

  it('✅ TEST- dev keys return valid (100 credits)', async () => {
    const { status, body } = await api('/api/verify-license', {
      method: 'POST', body: JSON.stringify({ licenseKey: 'TEST-ABCDEFGH' }),
    });
    assert.equal(status, 200);
    assert.equal(body.valid, true);
    assert.equal(body.credits, 100);
    assert.equal(body.label, 'Test Pack');
  });

  it('❌ rejects missing licenseKey', async () => {
    const { status, body } = await api('/api/verify-license', {
      method: 'POST', body: JSON.stringify({}),
    });
    assert.equal(status, 400);
    assert.equal(body.valid, false);
  });

  it('❌ rejects unknown license key', async () => {
    const { body } = await api('/api/verify-license', {
      method: 'POST', body: JSON.stringify({ licenseKey: 'MLS-AAAAAA-BBBBBB-CCCCCC' }),
    });
    assert.equal(body.valid, false);
    assert.match(body.error, /not found/i);
  });

  it('❌ TEST- key too short is rejected', async () => {
    const { body } = await api('/api/verify-license', {
      method: 'POST', body: JSON.stringify({ licenseKey: 'TEST-ABC' }),
    });
    // TEST- keys need length >= 12
    assert.equal(body.valid, false);
  });
});

// ═══════════════════════════════════════════════════════════════
//  5. END-TO-END MOCK PAYMENT FLOW — ALL 3 PLANS
//     checkout → Paddle confirms → webhook → license created
// ═══════════════════════════════════════════════════════════════
describe('End-to-end mock payment flow for all 3 plans', () => {

  const plans = [
    { label: 'Starter Pack', priceId: 'pri_test_100',  credits: 100,  price: '$5'  },
    { label: 'Pro Pack',     priceId: 'pri_test_500',  credits: 500,  price: '$19' },
    { label: 'Agency Pack',  priceId: 'pri_test_1000', credits: 1000, price: '$35' },
  ];

  for (const plan of plans) {
    it(`🔄 ${plan.label} full flow: checkout → payment → webhook → license (${plan.credits} credits)`, async () => {
      const txnId = `txn_e2e_${plan.credits}_${Date.now()}`;

      // ── Step 1: User clicks "Buy" → POST /api/checkout ──
      mockFetchResponse = {
        ok: true, status: 200,
        data: {
          data: {
            id: txnId,
            checkout: { url: `https://checkout.paddle.com/pay?txn=${txnId}` },
          },
        },
      };

      const checkout = await api('/api/checkout', {
        method: 'POST',
        body: JSON.stringify({ priceId: plan.priceId }),
      });

      assert.equal(checkout.status, 200, `Step 1 failed: checkout for ${plan.label}`);
      assert.ok(checkout.body.checkoutUrl.includes(txnId), 'Checkout URL contains txn ID');

      // ── Step 2: User pays → Paddle sends webhook ──
      const licensesBefore = (await api('/api/health')).body.licenses;

      const webhook = await sendWebhook({
        event_type: 'transaction.completed',
        data: {
          id: txnId,
          custom_data: { priceId: plan.priceId },
          customer: { email: `e2e-${plan.credits}@test.com` },
          items: [{ price: { id: plan.priceId } }],
        },
      });

      assert.equal(webhook.status, 200, `Step 2 failed: webhook for ${plan.label}`);
      assert.equal(webhook.body.ok, true);

      // ── Step 3: Verify license was created ──
      const licensesAfter = (await api('/api/health')).body.licenses;
      assert.equal(licensesAfter, licensesBefore + 1,
        `Step 3 failed: license count should increase for ${plan.label}`);

      // ── Step 4: Verify dev TEST- key still works (extension-side testing) ──
      const verify = await api('/api/verify-license', {
        method: 'POST',
        body: JSON.stringify({ licenseKey: `TEST-E2E-${plan.credits}` }),
      });
      assert.equal(verify.status, 200);
      assert.equal(verify.body.valid, true);
    });
  }
});