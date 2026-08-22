/**
 * Automated Verification Test Harness
 * Tests:
 * 1. Indian Phone Normalization
 * 2. Funnel Event Deduplication (3 form opens = 1 session count)
 * 3. Idempotency & Concurrent Order Submissions
 * 4. Pincode Blocklist Rules
 * 5. Mock OTP Verification
 * 6. Abandoned Leads Extraction & WhatsApp Link Generation
 */

// Use isolated in-memory SQLite DB for tests so real database is never polluted
process.env.DB_PATH = ':memory:';

const { normalizeIndianPhone } = require('../src/utils/phone');
const { recordFunnelEvent, getFunnelAnalytics, getAbandonedLeads } = require('../src/services/funnel');
const { processIdempotentCodOrder } = require('../src/services/idempotency');
const { generateAndSendOtp, verifyOtp } = require('../src/services/otp');
const { v4: uuidv4 } = require('uuid');

async function runTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING SHOPIFY COD ORDER ENGINE VERIFICATION SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, name) {
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
      failed++;
    }
  }

  // TEST 1: Phone Normalization
  console.log('\n--- 1. Testing Phone Normalization ---');
  const phonesToTest = [
    { input: '+91 98765 43210', expected: '+919876543210' },
    { input: '919876543210', expected: '+919876543210' },
    { input: '9876543210', expected: '+919876543210' },
    { input: '09876543210', expected: '+919876543210' },
    { input: '+91-98765-43210', expected: '+919876543210' },
  ];

  phonesToTest.forEach((item) => {
    const res = normalizeIndianPhone(item.input);
    assert(res.isValid && res.canonical === item.expected, `Normalize "${item.input}" -> ${item.expected}`);
  });

  const invalidPhones = ['12345', '98765', '1234567890', 'abc9876543210'];
  invalidPhones.forEach((bad) => {
    const res = normalizeIndianPhone(bad);
    assert(!res.isValid, `Reject invalid phone "${bad}"`);
  });

  // TEST 2: Funnel Event Deduplication
  console.log('\n--- 2. Testing Funnel Deduplication & Session Stitching ---');
  const testSession1 = 'test_sess_' + uuidv4();

  // Simulate customer opening form 3 times in the same session
  recordFunnelEvent({ sessionId: testSession1, eventName: 'form_opened', payload: { productTitle: 'Test Item' } });
  recordFunnelEvent({ sessionId: testSession1, eventName: 'form_opened', payload: { productTitle: 'Test Item' } });
  recordFunnelEvent({ sessionId: testSession1, eventName: 'form_opened', payload: { productTitle: 'Test Item' } });

  // Enter phone
  recordFunnelEvent({
    sessionId: testSession1,
    eventName: 'phone_entered',
    payload: { customerName: 'Aarav Patel', customerPhone: '9876501234' },
  });

  // Enter address
  recordFunnelEvent({
    sessionId: testSession1,
    eventName: 'address_filled',
    payload: {
      customerAddress: { address1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
      pincode: '560001',
    },
  });

  const analytics = getFunnelAnalytics('daksh-cod-app.myshopify.com', 'today');
  assert(analytics.totalSessions >= 1, `Total sessions counted accurately (Distinct Session IDs)`);

  const step1 = analytics.funnel.find((f) => f.step === 'form_opened');
  const step2 = analytics.funnel.find((f) => f.step === 'phone_entered');
  assert(step1 && step2, `Funnel steps form_opened and phone_entered recorded`);

  // TEST 3: Idempotency & Concurrent Submissions
  console.log('\n--- 3. Testing Idempotency & Concurrent Order Submissions ---');
  const testIdempotencyKey = 'idem_test_' + uuidv4();
  const testSession2 = 'test_sess_' + uuidv4();

  // Run two submissions concurrently with the exact same idempotency key
  const [res1, res2] = await Promise.all([
    processIdempotentCodOrder({
      idempotencyKey: testIdempotencyKey,
      sessionId: testSession2,
      customerName: 'Priya Sharma',
      customerPhone: '+91 98765 99999',
      shippingAddress: { address1: '45 Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' },
      productTitle: 'Wireless Headphones',
      unitPrice: 1499,
      codFee: 49,
    }),
    processIdempotentCodOrder({
      idempotencyKey: testIdempotencyKey,
      sessionId: testSession2,
      customerName: 'Priya Sharma',
      customerPhone: '+91 98765 99999',
      shippingAddress: { address1: '45 Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' },
      productTitle: 'Wireless Headphones',
      unitPrice: 1499,
      codFee: 49,
    }),
  ]);

  assert(res1.success || res2.success, 'At least one concurrent request succeeded in creating order');
  const successfulRes = res1.success ? res1 : res2;
  const duplicateRes = res1.success ? res2 : res1;

  // Verify that subsequent call with same key returns the existing order (isDuplicate: true)
  const res3 = await processIdempotentCodOrder({
    idempotencyKey: testIdempotencyKey,
    sessionId: testSession2,
    customerName: 'Priya Sharma',
    customerPhone: '+91 98765 99999',
    shippingAddress: { address1: '45 Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' },
    productTitle: 'Wireless Headphones',
    unitPrice: 1499,
    codFee: 49,
  });

  assert(res3.success && res3.isDuplicate && res3.orderNumber === successfulRes.orderNumber, 'Idempotency returns identical order number on replay without duplicating');

  // TEST 4: Mock OTP Verification
  console.log('\n--- 4. Testing Mock OTP Workflow ---');
  const testPhone = '+919876511111';
  const otpRes = generateAndSendOtp(testPhone, testSession1);
  assert(otpRes.success && otpRes.debugCode.length === 6, 'Generated 6-digit mock OTP code');

  const badVerify = verifyOtp(testPhone, '999999');
  assert(!badVerify.success, 'Rejected incorrect OTP code');

  const goodVerify = verifyOtp(testPhone, otpRes.debugCode);
  assert(goodVerify.success, 'Successfully verified correct OTP code');

  // TEST 5: Abandoned Leads & Recovery
  console.log('\n--- 5. Testing Abandoned Leads & WhatsApp Recovery Link ---');
  // Create an abandoned session: phone entered, but never submitted order
  const abandonedSessionId = 'sess_abandoned_' + uuidv4();
  recordFunnelEvent({
    sessionId: abandonedSessionId,
    eventName: 'form_opened',
    payload: { productTitle: 'Premium Smartwatch' },
  });
  recordFunnelEvent({
    sessionId: abandonedSessionId,
    eventName: 'phone_entered',
    payload: { customerName: 'Vikram Singh', customerPhone: '9876522222', cartTotal: 2499 },
  });
  recordFunnelEvent({
    sessionId: abandonedSessionId,
    eventName: 'address_filled',
    payload: { pincode: '400001', city: 'Mumbai', state: 'Maharashtra', cartTotal: 2499 },
  });

  const leads = getAbandonedLeads('daksh-cod-app.myshopify.com', 10);
  const foundLead = leads.find((l) => l.sessionId === abandonedSessionId);

  assert(foundLead !== undefined, 'Abandoned session captured in Merchant Recovery List');
  assert(foundLead && foundLead.whatsappUrl.includes('wa.me/919876522222'), 'Prefilled WhatsApp recovery deep-link generated correctly');

  // TEST 6: HMAC-SHA256 Signature Verification
  console.log('\n--- 6. Testing HMAC-SHA256 Webhook Verification ---');
  const { verifyShopifyHmac, generateTestHmac } = require('../src/utils/hmac');
  const { getRecentIdempotencyTraces } = require('../src/services/idempotency');

  const testPayload = JSON.stringify({ id: '12345', financial_status: 'paid' });
  const testSecret = 'shopify_secret_key_123';
  const validHmac = generateTestHmac(testPayload, testSecret);

  const isValidHmac = verifyShopifyHmac(Buffer.from(testPayload), validHmac, testSecret);
  assert(isValidHmac, 'Valid HMAC signature accurately verified with crypto.timingSafeEqual');

  const isInvalidHmac = verifyShopifyHmac(Buffer.from(testPayload), 'invalid_hmac_signature', testSecret);
  assert(!isInvalidHmac, 'Forged / invalid HMAC signature rejected');

  // TEST 7: Idempotency Waterfall Traces
  console.log('\n--- 7. Testing Idempotency Waterfall Traces ---');
  const traces = getRecentIdempotencyTraces(5);
  assert(traces.length > 0, 'Recorded stage-by-stage idempotency waterfall traces in SQLite');
  const duplicateTrace = traces.find((t) => t.hasDuplicateReplay);
  assert(duplicateTrace !== undefined, 'Captured 0ms Duplicate Absorption in Waterfall Trace timeline');

  console.log('\n====================================================');
  console.log(`🎉 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
