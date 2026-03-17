import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(testsDir, '..');

async function withServer(env, callback) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${env.PORT}`;
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        try {
          return await callback(baseUrl);
        } finally {
          child.kill();
        }
      }
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }

  child.kill();
  throw new Error(`Server did not become ready. ${lastError?.message || output}`);
}

test('backend /api/payment-config returns configured checkout URL', async () => {
  await withServer({ PORT: '3411', PAYMENT_CHECKOUT_URL: 'https://buy.paddle.com/product/test-pack', SUCCESS_URL: '', PADDLE_API_KEY: 'test-key' }, async baseUrl => {
    const health = await fetch(`${baseUrl}/api/health`).then(response => response.json());
    assert.equal(health.checkoutConfigured, true);

    const config = await fetch(`${baseUrl}/api/payment-config`).then(response => response.json());
    assert.equal(config.checkoutUrl, 'https://buy.paddle.com/product/test-pack');
  });
});

test('backend /api/payment-config returns 404 when checkout URL is missing', async () => {
  await withServer({ PORT: '3412', PAYMENT_CHECKOUT_URL: '', SUCCESS_URL: '', PADDLE_API_KEY: 'test-key' }, async baseUrl => {
    const health = await fetch(`${baseUrl}/api/health`).then(response => response.json());
    assert.equal(health.checkoutConfigured, false);

    const response = await fetch(`${baseUrl}/api/payment-config`);
    const payload = await response.json();
    assert.equal(response.status, 404);
    assert.match(payload.error, /not configured/i);
  });
});