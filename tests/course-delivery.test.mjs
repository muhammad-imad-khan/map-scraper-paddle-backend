import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helpersPath = require.resolve('../lib/helpers.js');
const nodemailer = require('nodemailer');
const originalCreateTransport = nodemailer.createTransport;
const originalFetch = global.fetch;

function createRedisMock() {
  const store = new Map();
  const getList = (key) => {
    const current = store.get(key);
    if (Array.isArray(current)) return current;
    if (current == null) return [];
    return [current];
  };

  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
      return 'OK';
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    async rpush(key, value) {
      const list = getList(key);
      list.push(value);
      store.set(key, list);
      return list.length;
    },
    async lrange(key) {
      return [...getList(key)];
    },
    async lrem(key, _count, value) {
      const list = getList(key).filter((item) => item !== value);
      store.set(key, list);
      return 1;
    },
    async scan() {
      return ['0', []];
    },
    pipeline() {
      const commands = [];
      return {
        get(key) {
          commands.push(key);
          return this;
        },
        async exec() {
          return commands.map((key) => [null, store.has(key) ? store.get(key) : null]);
        },
      };
    },
  };
}

function loadHelpers() {
  delete require.cache[helpersPath];
  return require(helpersPath);
}

function clearCourseEnv() {
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.COURSE_LINK;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
}

beforeEach(() => {
  clearCourseEnv();
  delete require.cache[helpersPath];
});

afterEach(() => {
  nodemailer.createTransport = originalCreateTransport;
  global.fetch = originalFetch;
  clearCourseEnv();
  delete require.cache[helpersPath];
});

describe('deliverCoursePurchase', () => {
  it('sends the Drive-link email and stores the delivery record', async () => {
    const sentMail = [];
    process.env.SMTP_USER = 'sender@example.com';
    process.env.SMTP_PASS = 'app-password';
    process.env.COURSE_LINK = 'https://drive.google.com/drive/folders/test-folder?usp=drive_link';

    nodemailer.createTransport = () => ({
      async sendMail(mail) {
        sentMail.push(mail);
      },
    });

    const { deliverCoursePurchase } = loadHelpers();
    const redis = createRedisMock();

    const result = await deliverCoursePurchase({
      redis,
      email: 'Buyer@Test.com',
      name: 'Buyer',
      txnId: 'txn_course_1',
    });

    assert.equal(result.ok, true);
    assert.equal(result.alreadySent, false);
    assert.equal(result.email, 'buyer@test.com');
    assert.equal(result.driveShared, false);
    assert.equal(result.driveError, 'google_credentials_missing');
    assert.equal(sentMail.length, 1);
    assert.equal(sentMail[0].to, 'buyer@test.com');
    assert.match(sentMail[0].html, /drive\.google\.com/);
    assert.match(sentMail[0].html, /Open Course Folder/);

    const stored = JSON.parse(await redis.get('course-delivered:buyer@test.com'));
    assert.equal(stored.txnId, 'txn_course_1');
    assert.equal(stored.sharedDrive, false);
    assert.equal(stored.driveError, 'google_credentials_missing');
  });

  it('does not mark the course as delivered when email sending fails', async () => {
    process.env.SMTP_USER = 'sender@example.com';
    process.env.SMTP_PASS = 'app-password';
    process.env.COURSE_LINK = 'https://drive.google.com/drive/folders/test-folder?usp=drive_link';

    nodemailer.createTransport = () => ({
      async sendMail() {
        throw new Error('SMTP offline');
      },
    });

    const { deliverCoursePurchase } = loadHelpers();
    const redis = createRedisMock();

    const result = await deliverCoursePurchase({
      redis,
      email: 'buyer@test.com',
      name: 'Buyer',
      txnId: 'txn_course_2',
    });

    assert.equal(result.ok, false);
    assert.equal(result.alreadySent, false);
    assert.match(result.error, /SMTP offline|smtp_send_failed/i);
    assert.equal(await redis.get('course-delivered:buyer@test.com'), null);
  });

  it('does not send the course email twice for the same address', async () => {
    const sentMail = [];
    process.env.SMTP_USER = 'sender@example.com';
    process.env.SMTP_PASS = 'app-password';
    process.env.COURSE_LINK = 'https://drive.google.com/drive/folders/test-folder?usp=drive_link';

    nodemailer.createTransport = () => ({
      async sendMail(mail) {
        sentMail.push(mail);
      },
    });

    const { deliverCoursePurchase } = loadHelpers();
    const redis = createRedisMock();

    const first = await deliverCoursePurchase({
      redis,
      email: 'buyer@test.com',
      name: 'Buyer',
      txnId: 'txn_course_3',
    });
    const second = await deliverCoursePurchase({
      redis,
      email: 'buyer@test.com',
      name: 'Buyer',
      txnId: 'txn_course_3_retry',
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.alreadySent, true);
    assert.equal(sentMail.length, 1);
  });

  it('uses Resend when configured', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'Imad Khan Courses <courses@example.com>';
    process.env.COURSE_LINK = 'https://drive.google.com/drive/folders/test-folder?usp=drive_link';

    global.fetch = async (url, options) => {
      assert.equal(url, 'https://api.resend.com/emails');
      const body = JSON.parse(options.body);
      assert.deepEqual(body.to, ['buyer@test.com']);
      assert.equal(body.from, 'Imad Khan Courses <courses@example.com>');
      return {
        ok: true,
        json: async () => ({ id: 're_123' }),
      };
    };

    const { deliverCoursePurchase } = loadHelpers();
    const redis = createRedisMock();

    const result = await deliverCoursePurchase({
      redis,
      email: 'buyer@test.com',
      name: 'Buyer',
      txnId: 'txn_course_resend',
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, 'resend');
  });

  it('forceResend bypasses the delivery marker and sends again', async () => {
    const sentMail = [];
    process.env.SMTP_USER = 'sender@example.com';
    process.env.SMTP_PASS = 'app-password';
    process.env.COURSE_LINK = 'https://drive.google.com/drive/folders/test-folder?usp=drive_link';

    nodemailer.createTransport = () => ({
      async sendMail(mail) {
        sentMail.push(mail);
      },
    });

    const { deliverCoursePurchase } = loadHelpers();
    const redis = createRedisMock();

    await redis.set('course-delivered:buyer@test.com', JSON.stringify({
      email: 'buyer@test.com',
      txnId: 'txn_old',
      deliveredAt: new Date().toISOString(),
    }));

    const result = await deliverCoursePurchase({
      redis,
      email: 'buyer@test.com',
      name: 'Buyer',
      txnId: 'txn_course_retry',
      forceResend: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.resent, true);
    assert.equal(sentMail.length, 1);
  });
});