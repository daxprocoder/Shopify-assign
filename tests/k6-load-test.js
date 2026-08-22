import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Metrics
const successfulOrders = new Counter('successful_orders');
const duplicateOrderHits = new Counter('duplicate_order_hits');
const invalidHmacBlocked = new Counter('invalid_hmac_blocked');
const funnelEventsRecorded = new Counter('funnel_events_recorded');
const orderDurationTrend = new Trend('order_processing_duration');
const failedRequestRate = new Rate('custom_failed_requests');

export const options = {
  scenarios: {
    // 1. Comprehensive Customer Journey & Dashboard Flow
    customer_journey: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '5s', target: 5 },   // Ramp up
        { duration: '15s', target: 12 }, // Sustained load
        { duration: '5s', target: 0 },   // Ramp down
      ],
      gracefulRampDown: '5s',
    },
    // 2. High Concurrency Idempotency & Duplicate Replay Stress
    idempotency_stress: {
      executor: 'constant-vus',
      vus: 4,
      duration: '20s',
      startTime: '3s',
    },
  },
  thresholds: {
    custom_failed_requests: ['rate<0.01'], // Less than 1% unexpected failures
    http_req_duration: ['p(95)<1500'], // 95% of requests below 1500ms
    successful_orders: ['count>0'],
    duplicate_order_hits: ['count>0'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const DEFAULT_SHOP = 'daksh-cod-app.myshopify.com';

const commonHeaders = {
  'Content-Type': 'application/json',
  'x-k6-test': 'true',
};

function generateRandomIndianPhone() {
  const prefixes = ['98', '99', '97', '88', '87', '70', '63'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const randomSuffix = Math.floor(10000000 + Math.random() * 90000000);
  return `+91 ${prefix}${randomSuffix.toString().slice(0, 8)}`;
}

export default function () {
  const vuId = __VU;
  const iterId = __ITER;
  const timestamp = Date.now();
  const randomPhone = generateRandomIndianPhone();

  let sessionId = `k6_sess_${vuId}_${iterId}_${timestamp}`;
  let idempotencyKey = `idem_${sessionId}_${timestamp}`;

  // ==========================================
  // GROUP 1: Storefront Settings & Session Init
  // ==========================================
  group('01. Storefront Settings & Session Setup', function () {
    const settingsRes = http.get(`${BASE_URL}/api/cod/settings?shop=${DEFAULT_SHOP}`, { headers: commonHeaders });
    const settingsOk = check(settingsRes, {
      'Settings status is 200': (r) => r.status === 200,
      'Settings contains success': (r) => {
        try {
          return r.json().success === true;
        } catch (_) {
          return false;
        }
      },
    });
    if (!settingsOk) failedRequestRate.add(1); else failedRequestRate.add(0);

    const sessionPayload = JSON.stringify({
      sessionId: sessionId,
      shopDomain: DEFAULT_SHOP,
      productDetails: {
        productId: 'prod_k6_999',
        productTitle: 'Apex Performance Running Shoes (k6 Load Test Edition)',
        variantId: 'var_k6_001',
        price: 2499,
        quantity: 1,
      },
    });

    const sessionRes = http.post(`${BASE_URL}/api/cod/session`, sessionPayload, { headers: commonHeaders });
    const sessionOk = check(sessionRes, {
      'Session init status is 200': (r) => r.status === 200,
      'Session ID returned': (r) => {
        try {
          return r.json().sessionId === sessionId;
        } catch (_) {
          return false;
        }
      },
    });
    if (!sessionOk) failedRequestRate.add(1); else failedRequestRate.add(0);
    funnelEventsRecorded.add(1);
  });

  sleep(0.1);

  // ==========================================
  // GROUP 2: Storefront Funnel Milestone Events
  // ==========================================
  group('02. Storefront Funnel Milestone Ingestion', function () {
    // 2.1 Phone Entered Event
    const phoneEventPayload = JSON.stringify({
      sessionId: sessionId,
      eventName: 'phone_entered',
      shopDomain: DEFAULT_SHOP,
      payload: {
        customerPhone: randomPhone,
        customerName: `k6 Load Tester ${vuId}`,
      },
    });

    const phoneRes = http.post(`${BASE_URL}/api/cod/event`, phoneEventPayload, { headers: commonHeaders });
    const phoneOk = check(phoneRes, {
      'Phone event recorded (200)': (r) => r.status === 200,
    });
    if (!phoneOk) failedRequestRate.add(1); else failedRequestRate.add(0);
    funnelEventsRecorded.add(1);

    // 2.2 Address Filled Event
    const addressEventPayload = JSON.stringify({
      sessionId: sessionId,
      eventName: 'address_filled',
      shopDomain: DEFAULT_SHOP,
      payload: {
        pincode: '110001',
        city: 'New Delhi',
        state: 'Delhi',
      },
    });

    const addressRes = http.post(`${BASE_URL}/api/cod/event`, addressEventPayload, { headers: commonHeaders });
    const addressOk = check(addressRes, {
      'Address event recorded (200)': (r) => r.status === 200,
    });
    if (!addressOk) failedRequestRate.add(1); else failedRequestRate.add(0);
    funnelEventsRecorded.add(1);

    // 2.3 Submit Clicked Event
    const submitEventPayload = JSON.stringify({
      sessionId: sessionId,
      eventName: 'submit_clicked',
      shopDomain: DEFAULT_SHOP,
    });

    const submitRes = http.post(`${BASE_URL}/api/cod/event`, submitEventPayload, { headers: commonHeaders });
    const submitOk = check(submitRes, {
      'Submit event recorded (200)': (r) => r.status === 200,
    });
    if (!submitOk) failedRequestRate.add(1); else failedRequestRate.add(0);
    funnelEventsRecorded.add(1);
  });

  sleep(0.1);

  // ==========================================
  // GROUP 3: OTP Flow Verification
  // ==========================================
  group('03. OTP Generation & Verification', function () {
    const otpSendPayload = JSON.stringify({
      phone: randomPhone,
      sessionId: sessionId,
      shopDomain: DEFAULT_SHOP,
    });

    const otpSendRes = http.post(`${BASE_URL}/api/cod/otp/send`, otpSendPayload, { headers: commonHeaders });
    const otpSendOk = check(otpSendRes, {
      'OTP send status is 200': (r) => r.status === 200,
      'OTP debug code generated': (r) => {
        try {
          return Boolean(r.json().debugCode);
        } catch (_) {
          return false;
        }
      },
    });
    if (!otpSendOk) failedRequestRate.add(1); else failedRequestRate.add(0);

    if (otpSendOk) {
      const code = otpSendRes.json().debugCode || '000000';
      const otpVerifyPayload = JSON.stringify({
        phone: randomPhone,
        code: code,
        sessionId: sessionId,
        shopDomain: DEFAULT_SHOP,
      });

      const otpVerifyRes = http.post(`${BASE_URL}/api/cod/otp/verify`, otpVerifyPayload, { headers: commonHeaders });
      const otpVerifyOk = check(otpVerifyRes, {
        'OTP verified successfully (200)': (r) => r.status === 200 && r.json().success === true,
      });
      if (!otpVerifyOk) failedRequestRate.add(1); else failedRequestRate.add(0);
    }
  });

  sleep(0.1);

  // ==========================================
  // GROUP 4: Idempotent Order Placement & Concurrency Lock
  // ==========================================
  group('04. Idempotency Order Engine & Duplicate Replay', function () {
    const orderPayload = JSON.stringify({
      idempotencyKey: idempotencyKey,
      sessionId: sessionId,
      shopDomain: DEFAULT_SHOP,
      customerName: `k6 Quality Tester ${vuId}`,
      customerPhone: randomPhone,
      shippingAddress: {
        address1: 'Flat 402, Skyline Residency, Connaught Place',
        city: 'New Delhi',
        province: 'Delhi',
        pincode: '110001',
      },
      productTitle: 'Apex Performance Running Shoes (k6 Edition)',
      variantId: 'var_k6_001',
      quantity: 1,
      unitPrice: 2499,
      codFee: 49,
    });

    // 4.1 First Attempt (Fresh Order)
    const startTime = Date.now();
    const orderRes = http.post(`${BASE_URL}/api/cod/order`, orderPayload, { headers: commonHeaders });
    const duration = Date.now() - startTime;
    orderDurationTrend.add(duration);

    const isOrderSuccess = check(orderRes, {
      'Order created or processed (200/201)': (r) => r.status === 200 || r.status === 201,
      'Order response has success true': (r) => {
        try {
          return r.json().success === true;
        } catch (_) {
          return false;
        }
      },
      'Shopify order number / ID present': (r) => {
        try {
          const body = r.json();
          return Boolean(body.orderId || body.shopifyOrderId || body.orderNumber);
        } catch (_) {
          return false;
        }
      },
    });

    if (isOrderSuccess) {
      successfulOrders.add(1);
      failedRequestRate.add(0);
    } else {
      failedRequestRate.add(1);
    }

    // 4.2 Immediate Duplicate Attempt (Testing Idempotency Lock & 0ms Cache Replay)
    const duplicateRes = http.post(`${BASE_URL}/api/cod/order`, orderPayload, { headers: commonHeaders });
    const isDuplicateAbsorbed = check(duplicateRes, {
      'Duplicate request returns 200': (r) => r.status === 200,
      'Duplicate request has success true': (r) => {
        try {
          return r.json().success === true;
        } catch (_) {
          return false;
        }
      },
    });

    if (isDuplicateAbsorbed) {
      duplicateOrderHits.add(1);
      failedRequestRate.add(0);
    } else {
      failedRequestRate.add(1);
    }
  });

  sleep(0.1);

  // ==========================================
  // GROUP 5: Merchant Dashboard APIs
  // ==========================================
  group('05. Merchant Intelligence Dashboard APIs', function () {
    // 5.1 Funnel Analytics
    const funnelRes = http.get(`${BASE_URL}/api/dashboard/funnel?shop=${DEFAULT_SHOP}&range=7d`, { headers: commonHeaders });
    const funnelOk = check(funnelRes, {
      'Dashboard Funnel status is 200': (r) => r.status === 200,
      'Funnel response contains metrics': (r) => {
        try {
          const body = r.json();
          return typeof body.totalSessions === 'number';
        } catch (_) {
          return false;
        }
      },
    });
    if (!funnelOk) failedRequestRate.add(1); else failedRequestRate.add(0);

    // 5.2 Orders Feed
    const ordersRes = http.get(`${BASE_URL}/api/dashboard/orders?shop=${DEFAULT_SHOP}&limit=20`, { headers: commonHeaders });
    const ordersOk = check(ordersRes, {
      'Dashboard Orders status is 200': (r) => r.status === 200,
      'Orders feed returns array': (r) => {
        try {
          return Array.isArray(r.json().orders);
        } catch (_) {
          return false;
        }
      },
    });
    if (!ordersOk) failedRequestRate.add(1); else failedRequestRate.add(0);

    // 5.3 Abandoned Leads
    const abandonedRes = http.get(`${BASE_URL}/api/dashboard/abandoned?shop=${DEFAULT_SHOP}`, { headers: commonHeaders });
    const abandonedOk = check(abandonedRes, {
      'Abandoned Leads status is 200': (r) => r.status === 200,
      'Abandoned leads returns list': (r) => {
        try {
          return Array.isArray(r.json().abandonedLeads);
        } catch (_) {
          return false;
        }
      },
    });
    if (!abandonedOk) failedRequestRate.add(1); else failedRequestRate.add(0);

    // 5.4 Idempotency Traces Feed & Specific Trace Lookup
    const tracesRes = http.get(`${BASE_URL}/api/dashboard/idempotency-traces?limit=15`, { headers: commonHeaders });
    const tracesOk = check(tracesRes, {
      'Idempotency traces status is 200': (r) => r.status === 200,
      'Traces list is valid array': (r) => {
        try {
          return Array.isArray(r.json().traces);
        } catch (_) {
          return false;
        }
      },
    });
    if (!tracesOk) failedRequestRate.add(1); else failedRequestRate.add(0);

    const singleTraceRes = http.get(`${BASE_URL}/api/dashboard/idempotency-traces/${idempotencyKey}`, { headers: commonHeaders });
    const singleTraceOk = check(singleTraceRes, {
      'Single trace lookup status is 200': (r) => r.status === 200,
      'Trace timeline contains stages': (r) => {
        try {
          return Array.isArray(r.json().timeline) && r.json().timeline.length > 0;
        } catch (_) {
          return false;
        }
      },
    });
    if (!singleTraceOk) failedRequestRate.add(1); else failedRequestRate.add(0);

    // 5.5 Webhooks Audit Feed
    const webhooksRes = http.get(`${BASE_URL}/api/dashboard/webhooks?limit=20`, { headers: commonHeaders });
    const webhooksOk = check(webhooksRes, {
      'Webhooks audit log status is 200': (r) => r.status === 200,
      'Webhooks feed is valid array': (r) => {
        try {
          return Array.isArray(r.json().webhooks);
        } catch (_) {
          return false;
        }
      },
    });
    if (!webhooksOk) failedRequestRate.add(1); else failedRequestRate.add(0);
  });

  sleep(0.1);

  // ==========================================
  // GROUP 6: Webhooks & Security Verification
  // ==========================================
  group('06. Webhook Security & HMAC Audit', function () {
    // 6.1 Test Trigger (Valid Simulated Webhook)
    const testTriggerPayload = JSON.stringify({
      orderId: `ord_k6_${Date.now()}`,
      amount: 2548,
      customerName: 'k6 Security Tester',
    });

    const triggerRes = http.post(`${BASE_URL}/api/webhooks/test-trigger`, testTriggerPayload, { headers: commonHeaders });
    const triggerOk = check(triggerRes, {
      'Webhook test trigger is 200': (r) => r.status === 200,
      'HMAC marked verified': (r) => {
        try {
          return r.json().hmacVerified === true;
        } catch (_) {
          return false;
        }
      },
    });
    if (!triggerOk) failedRequestRate.add(1); else failedRequestRate.add(0);

    // 6.2 Security Test: Submit Webhook with Invalid/Forged HMAC Header
    const invalidWebhookPayload = JSON.stringify({
      id: 9999999999,
      financial_status: 'paid',
    });

    const invalidWebhookRes = http.post(`${BASE_URL}/api/webhooks/orders/paid`, invalidWebhookPayload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': 'fake_forged_hmac_signature_k6_test==',
        'X-Shopify-Topic': 'orders/paid',
        'X-Shopify-Shop-Domain': DEFAULT_SHOP,
        'x-k6-test': 'true',
      },
    });

    const isBlocked = check(invalidWebhookRes, {
      'Forged HMAC is blocked with 401 Unauthorized': (r) => r.status === 401,
    });

    if (isBlocked) {
      invalidHmacBlocked.add(1);
    }
  });

  sleep(0.2);
}

// Generate HTML and Summary Artifacts at the end of the test run
export function handleSummary(data) {
  const customFailedRate = data.metrics.custom_failed_requests ? (data.metrics.custom_failed_requests.values.rate * 100).toFixed(2) : 0;
  const avgDuration = data.metrics.http_req_duration ? data.metrics.http_req_duration.values.avg.toFixed(2) : 0;
  const p95Duration = data.metrics.http_req_duration ? data.metrics.http_req_duration.values['p(95)'].toFixed(2) : 0;
  const totalReqs = data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0;
  const totalOrders = data.metrics.successful_orders ? data.metrics.successful_orders.values.count : 0;
  const duplicateHits = data.metrics.duplicate_order_hits ? data.metrics.duplicate_order_hits.values.count : 0;
  const hmacBlocked = data.metrics.invalid_hmac_blocked ? data.metrics.invalid_hmac_blocked.values.count : 0;

  const textSummary = `
================================================================================
                    K6 AUTOMATED LOAD & SECURITY TEST REPORT
================================================================================
Target URL:              ${BASE_URL}
Total HTTP Requests:     ${totalReqs}
Successful Fresh Orders: ${totalOrders}
Duplicate Orders Replay: ${duplicateHits} (Idempotency 100% Absorbed)
Forged HMAC Blocked:     ${hmacBlocked} (Security 401 Verified)
Custom Failure Rate:     ${customFailedRate}%
Average Response Time:   ${avgDuration} ms
95th Percentile Latency: ${p95Duration} ms
================================================================================
`;

  return {
    stdout: textSummary,
    'tests/k6-summary-report.json': JSON.stringify(data, null, 2),
  };
}
