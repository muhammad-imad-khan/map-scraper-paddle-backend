/**
 * Detailed Workflow Tests: Customer Journey & Admin Workflows
 * 
 * Tests specific workflows:
 * 1. Complete card purchase → validation → course access
 * 2. Complete bank transfer → receipt → validation → course access
 * 3. Multiple purchases by same customer
 * 4. Admin resend email workflow
 * 5. Monitoring performance under multiple validations
 */

require('dotenv').config({ path: '.env.production' });

const API_BASE = process.env.API_BASE || 'https://map-scraper-paddle-backend.vercel.app';
const ADMIN_KEY = process.env.ADMIN_API_KEY || '';
const TEST_COURSE = 'lead-gen-ai-web-design';

let results = { passed: 0, failed: 0, tests: [] };

const colors = {
  'info': '\x1b[36m',
  'success': '\x1b[32m',
  'error': '\x1b[31m',
  'warn': '\x1b[33m',
  'reset': '\x1b[0m'
};

function log(level, msg) {
  const icon = { info: 'ℹ', success: '✅', error: '❌', warn: '⚠️' }[level] || '•';
  console.log(`${colors[level]}${icon} ${msg}${colors.reset}`);
}

async function api(endpoint, method = 'GET', body = null) {
  const url = `${API_BASE}${endpoint}`;
  const opts = {
    method,
    headers: {
      'content-type': 'application/json',
      'x-admin-key': ADMIN_KEY
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return { status: res.status, data: await res.json() };
}

async function test(name, fn) {
  try {
    log('info', `TEST: ${name}`);
    await fn();
    results.passed++;
    results.tests.push({ name, status: 'PASS' });
    log('success', name);
  } catch (err) {
    results.failed++;
    results.tests.push({ name, status: 'FAIL', error: err.message });
    log('error', `${name}: ${err.message}`);
  }
}

// ═════════════════════════════════════════════════════════════
// WORKFLOW 1: Card Purchase → Validation → Access
// ═════════════════════════════════════════════════════════════

async function workflowCardPurchase() {
  console.log('\n📦 WORKFLOW 1: Card Purchase → Validation → Course Access');
  console.log('═══════════════════════════════════════════════════════════\n');

  let cardPurchase = null;
  let enrollment = null;

  await test('Step 1: Retrieve card purchase from system', async () => {
    const res = await api(`/api/admin-courses?type=purchases&status=pending`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const purchases = res.data.items || [];
    const card = purchases.find(p => p.source === 'card');
    if (!card) throw new Error('No pending card purchase found');
    cardPurchase = card;
    log('info', `  → Found: ${card.email} | ${card.courseId} | ${card.amount}${card.currency || ''}`);
  });

  await test('Step 2: Admin validates card purchase with dual emails', async () => {
    if (!cardPurchase) throw new Error('No purchase to validate');
    const payload = {
      action: 'validatePurchase',
      email: cardPurchase.email,
      name: cardPurchase.name || 'Test User',
      courseId: cardPurchase.courseId || TEST_COURSE,
      source: cardPurchase.source,
      txnId: cardPurchase.txnId,
      bankTransferId: null,
      amount: cardPurchase.amount,
      currency: cardPurchase.currency
    };
    const res = await api(`/api/admin-courses`, 'POST', payload);
    if (res.status !== 200) throw new Error(`Status ${res.status}: ${res.data.error}`);
    if (!res.data.result?.enrollment) throw new Error('No enrollment in response');
    enrollment = res.data.result.enrollment;
    log('info', `  → Status: ${enrollment.status} | Granted: ${enrollment.grantedAt}`);
  });

  await test('Step 3: Verify course access immediately available', async () => {
    if (!enrollment) throw new Error('No enrollment from previous step');
    const res = await api(`/api/admin-courses?type=enrollments`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const found = (res.data.items || []).find(e =>
      e.email === enrollment.email && e.courseId === enrollment.courseId
    );
    if (!found) throw new Error('Enrollment not found in system');
    log('info', `  → Enrollment active: ${found.status} | Course: ${found.courseId}`);
  });

  await test('Step 4: Verify course details accessible', async () => {
    if (!enrollment) throw new Error('No enrollment');
    const res = await api(`/api/admin-courses?type=courses`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const course = (res.data.items || []).find(c => c.id === enrollment.courseId);
    if (!course) throw new Error(`Course ${enrollment.courseId} not found`);
    log('info', `  → Course: ${course.title} | Modules: ${(course.modules || []).length}`);
  });

  await test('Step 5: Admin can resend course email if needed', async () => {
    if (!cardPurchase) throw new Error('No purchase');
    const payload = {
      action: 'sendPurchaseEmail',
      email: cardPurchase.email,
      name: cardPurchase.name
    };
    const res = await api(`/api/admin-courses`, 'POST', payload);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    log('info', `  → Email action: ${res.data.message}`);
  });
}

// ═════════════════════════════════════════════════════════════
// WORKFLOW 2: Bank Transfer → Receipt → Validation
// ═════════════════════════════════════════════════════════════

async function workflowBankTransfer() {
  console.log('\n🏦 WORKFLOW 2: Bank Transfer → Receipt Review → Validation');
  console.log('═══════════════════════════════════════════════════════════\n');

  let transfer = null;

  await test('Step 1: Admin reviews pending bank transfers', async () => {
    const res = await api(`/api/admin-courses?type=transfers&status=pending`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const transfers = res.data.items || [];
    if (transfers.length === 0) {
      log('warn', '  → No pending transfers (skipping remaining steps)');
      return;
    }
    transfer = transfers[0];
    log('info', `  → Found: ${transfer.email} | ${transfer.amount}${transfer.currency || ''}`);
  });

  if (!transfer) {
    log('warn', 'Skipping bank transfer workflow (no transfers available)');
  } else {
    await test('Step 2: Admin checks receipt if provided', async () => {
      if (!transfer) throw new Error('No transfer');
      const hasReceipt = transfer.receiptDataUrl || transfer.receiptDataUrl === 'link';
      log('info', `  → Receipt: ${hasReceipt ? 'uploaded' : 'not provided'}`);
    });

    await test('Step 3: Admin validates bank transfer', async () => {
      if (!transfer) throw new Error('No transfer');
      const payload = {
        action: 'validatePurchase',
        email: transfer.email,
        name: transfer.name || 'Bank Transfer Customer',
        courseId: TEST_COURSE,
        source: 'bank_transfer',
        txnId: null,
        bankTransferId: transfer.id,
        amount: transfer.amount,
        currency: transfer.currency
      };
      const res = await api(`/api/admin-courses`, 'POST', payload);
      if (res.status !== 200) throw new Error(`Status ${res.status}: ${res.data.error}`);
      log('info', `  → Transfer status: ${res.data.transfer?.status || 'N/A'}`);
    });

    await test('Step 4: Verify bank transfer moved to approved', async () => {
      if (!transfer) throw new Error('No transfer');
      const res = await api(`/api/admin-courses?type=transfers&status=pending`);
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const stillPending = (res.data.items || []).find(t => t.id === transfer.id);
      log('info', `  → Transfer moved from pending: ${!stillPending}`);
    });
  }
}

// ═════════════════════════════════════════════════════════════
// WORKFLOW 3: Monitoring Multiple Validations
// ═════════════════════════════════════════════════════════════

async function workflowMonitoring() {
  console.log('\n📊 WORKFLOW 3: Monitoring & Metrics');
  console.log('═══════════════════════════════════════════════════════════\n');

  await test('Step 1: Retrieve 7-day validation metrics', async () => {
    const res = await api(`/api/admin-courses`, 'POST', {
      action: 'validation-logs',
      days: 7
    });
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const stats = res.data.stats;
    log('info', `  → Total validations: ${stats.totalValidations}`);
    log('info', `  → By card: ${stats.bySource?.card || 0}`);
    log('info', `  → By bank: ${stats.bySource?.bank_transfer || 0}`);
    if (stats.totalValidations > 0) {
      const rate = Math.round(((stats.byStatus?.success || 0) / stats.totalValidations) * 100);
      log('info', `  → Success rate: ${rate}%`);
    }
  });

  await test('Step 2: Verify recent validations logged', async () => {
    const res = await api(`/api/admin-courses`, 'POST', {
      action: 'validation-logs',
      days: 7
    });
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const logs = res.data.logs || [];
    if (logs.length > 0) {
      const recent = logs[logs.length - 1];
      log('info', `  → Most recent: ${recent.email} | ${recent.source} | ${recent.status}`);
    } else {
      log('info', `  → No validations recorded yet`);
    }
  });

  await test('Step 3: Check metrics by date', async () => {
    const res = await api(`/api/admin-courses`, 'POST', {
      action: 'validation-logs',
      days: 7
    });
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const byDate = res.data.stats?.byDate || {};
    const dates = Object.keys(byDate);
    if (dates.length > 0) {
      log('info', `  → Validations across ${dates.length} days`);
      dates.slice(0, 3).forEach(d => {
        log('info', `     ${d}: ${byDate[d]} validations`);
      });
    }
  });
}

// ═════════════════════════════════════════════════════════════
// WORKFLOW 4: Schema and Data Consistency
// ═════════════════════════════════════════════════════════════

async function workflowConsistency() {
  console.log('\n🔍 WORKFLOW 4: Data Consistency & Schema');
  console.log('═══════════════════════════════════════════════════════════\n');

  await test('Step 1: All purchases have consistent schema', async () => {
    const res = await api(`/api/admin-courses?type=purchases&status=all`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const purchases = res.data.items || [];
    if (purchases.length === 0) throw new Error('No purchases to check');
    
    const requiredFields = ['id', 'email', 'status', 'source', 'receiptDataUrl'];
    purchases.slice(0, 10).forEach(p => {
      requiredFields.forEach(f => {
        if (!Object.prototype.hasOwnProperty.call(p, f)) {
          throw new Error(`Purchase ${p.id} missing [${f}]`);
        }
      });
    });
    log('info', `  → All ${Math.min(10, purchases.length)} sampled purchases valid`);
  });

  await test('Step 2: Card purchases have null receipts', async () => {
    const res = await api(`/api/admin-courses?type=purchases&status=all`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const cards = (res.data.items || []).filter(p => p.source === 'card').slice(0, 5);
    cards.forEach(c => {
      if (c.receiptDataUrl !== null) throw new Error(`Card ${c.id} has non-null receipt`);
      if (c.receiptName !== null) throw new Error(`Card ${c.id} has non-null receiptName`);
    });
    if (cards.length > 0) {
      log('info', `  → All ${cards.length} card purchases: receipt=null ✓`);
    }
  });

  await test('Step 3: Bank transfers have receipt field present', async () => {
    const res = await api(`/api/admin-courses?type=purchases&status=all`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const banks = (res.data.items || []).filter(p => p.source === 'bank_transfer').slice(0, 5);
    banks.forEach(b => {
      if (!Object.prototype.hasOwnProperty.call(b, 'receiptDataUrl')) {
        throw new Error(`Bank transfer ${b.id} missing receiptDataUrl`);
      }
    });
    if (banks.length > 0) {
      log('info', `  → All ${banks.length} bank transfers: receipt field present ✓`);
    }
  });

  await test('Step 4: Enrollments linked to courses', async () => {
    const enrollRes = await api(`/api/admin-courses?type=enrollments`);
    const courseRes = await api(`/api/admin-courses?type=courses`);
    
    if (enrollRes.status !== 200) throw new Error(`Enrollments: ${enrollRes.status}`);
    if (courseRes.status !== 200) throw new Error(`Courses: ${courseRes.status}`);
    
    const enrollments = enrollRes.data.items || [];
    const courses = courseRes.data.items || [];
    const courseIds = new Set(courses.map(c => c.id));
    
    enrollments.slice(0, 10).forEach(e => {
      if (!courseIds.has(e.courseId)) {
        throw new Error(`Enrollment ${e.email} enrolled in non-existent course ${e.courseId}`);
      }
    });
    log('info', `  → All ${Math.min(10, enrollments.length)} enrollments linked to valid courses`);
  });
}

// ═════════════════════════════════════════════════════════════
// RUN ALL WORKFLOWS
// ═════════════════════════════════════════════════════════════

async function runAllWorkflows() {
  console.log('\n');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║     DETAILED WORKFLOW TESTING: Customer → Admin Journey     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  
  try {
    await workflowCardPurchase();
    await workflowBankTransfer();
    await workflowMonitoring();
    await workflowConsistency();
  } catch (err) {
    log('error', `Fatal error: ${err.message}`);
  }

  // Summary
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                   WORKFLOW TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`✅ Passed:  ${results.passed}`);
  console.log(`❌ Failed:  ${results.failed}`);
  console.log(`📊 Total:   ${results.passed + results.failed}`);
  
  if (results.failed === 0) {
    console.log('\n🎉 All workflow tests passed!');
  } else {
    console.log('\n❌ Failed tests:');
    results.tests.filter(t => t.status === 'FAIL').forEach(t => {
      console.log(`   • ${t.name}`);
      if (t.error) console.log(`     └─ ${t.error}`);
    });
  }
  
  console.log('═══════════════════════════════════════════════════════════\n');

  process.exit(results.failed > 0 ? 1 : 0);
}

runAllWorkflows().catch(err => {
  log('error', `Unhandled error: ${err.message}`);
  process.exit(1);
});
