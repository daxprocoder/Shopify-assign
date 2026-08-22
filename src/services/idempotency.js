const { sqlite } = require('../db');
const { v4: uuidv4 } = require('uuid');
const { createShopifyOrder } = require('./shopify');
const { recordFunnelEvent } = require('./funnel');
const { normalizeIndianPhone } = require('../utils/phone');

/**
 * Record a step in the Idempotency Waterfall Trace.
 */
function recordIdempotencyTrace({
  idempotencyKey,
  stepName,
  status = 'OK',
  durationMs = 0,
  details = {},
}) {
  const traceId = uuidv4();
  const now = Date.now();
  try {
    sqlite.prepare(`
      INSERT INTO idempotency_traces (id, idempotency_key, step_name, status, duration_ms, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(traceId, idempotencyKey, stepName, status, durationMs, JSON.stringify(details), now);
  } catch (err) {
    console.error('[Trace Log Error]:', err.message);
  }
}

/**
 * Retrieve the waterfall timeline trace for an idempotency key.
 */
function getTracesForKey(idempotencyKey) {
  const traces = sqlite.prepare(`
    SELECT * FROM idempotency_traces
    WHERE idempotency_key = ?
    ORDER BY created_at ASC
  `).all(idempotencyKey);

  return traces.map((t) => ({
    id: t.id,
    idempotencyKey: t.idempotency_key,
    stepName: t.step_name,
    status: t.status,
    durationMs: t.duration_ms,
    details: t.details ? JSON.parse(t.details) : {},
    timestamp: new Date(t.created_at).toISOString(),
  }));
}

/**
 * Retrieve recent idempotency traces grouped by key.
 */
function getRecentIdempotencyTraces(limit = 20) {
  const distinctKeys = sqlite.prepare(`
    SELECT DISTINCT idempotency_key, MAX(created_at) as latest
    FROM idempotency_traces
    GROUP BY idempotency_key
    ORDER BY latest DESC
    LIMIT ?
  `).all(limit);

  return distinctKeys.map((k) => {
    const traces = getTracesForKey(k.idempotency_key);
    const firstTrace = traces[0] || {};
    const lastTrace = traces[traces.length - 1] || {};
    const totalDuration = traces.reduce((sum, t) => sum + (t.durationMs || 0), 0);
    const hasDuplicate = traces.some((t) => t.stepName.includes('DUPLICATE') || t.stepName.includes('REPLAY'));

    return {
      idempotencyKey: k.idempotency_key,
      startedAt: firstTrace.timestamp || new Date(k.latest).toISOString(),
      finalStatus: lastTrace.status || 'UNKNOWN',
      totalSteps: traces.length,
      totalDurationMs: totalDuration,
      hasDuplicateReplay: hasDuplicate,
      traces,
    };
  });
}

/**
 * Idempotent COD Order Submission Handler
 *
 * Guarantees:
 * 1. Exactly-Once Execution: Under rapid double-clicks or retried network requests,
 *    only 1 Shopify order is created.
 * 2. In-Flight Concurrency Guard: Prevents concurrent race conditions using atomic DB locks.
 * 3. Transparent Recovery: Subsequent duplicate requests return the original order payload.
 * 4. Failure Recovery: Allows customer to retry legitimately failed attempts without being locked out.
 */
async function processIdempotentCodOrder({
  idempotencyKey,
  sessionId,
  shopDomain = 'daksh-cod-app.myshopify.com',
  customerName,
  customerPhone,
  shippingAddress,
  productTitle,
  variantId,
  quantity = 1,
  unitPrice = 0,
  codFee = 0,
  orderTag = 'COD-Form',
  ipAddress = null,
  userAgent = null,
}) {
  if (!idempotencyKey) {
    throw new Error('idempotency_key is required for order submission');
  }

  if (!sessionId) {
    throw new Error('session_id is required');
  }

  // Validate phone normalization
  const phoneValidation = normalizeIndianPhone(customerPhone);
  if (!phoneValidation.isValid) {
    return {
      success: false,
      statusCode: 400,
      error: phoneValidation.error,
    };
  }

  const canonicalPhone = phoneValidation.canonical;
  const now = Date.now();
  const addr = typeof shippingAddress === 'string' ? JSON.parse(shippingAddress) : shippingAddress;
  const addressJson = typeof shippingAddress === 'string' ? shippingAddress : JSON.stringify(shippingAddress);
  const totalPrice = (parseFloat(unitPrice) * parseInt(quantity, 10)) + parseFloat(codFee);

  // Record Stage 1: Request Ingress
  recordIdempotencyTrace({
    idempotencyKey,
    stepName: '1. REQUEST_INGRESS',
    status: 'RECEIVED',
    durationMs: 1,
    details: { sessionId, customerPhone: canonicalPhone, customerName, totalPrice },
  });

  // Ensure session exists in sessions table
  let existingSession = sqlite.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!existingSession) {
    sqlite.prepare(`
      INSERT INTO sessions (
        id, shop_domain, customer_name, customer_phone, customer_address,
        pincode, cart_total, product_title, variant_id, quantity, current_step,
        is_converted, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submit_clicked', 0, ?, ?)
    `).run(
      sessionId,
      shopDomain,
      customerName,
      canonicalPhone,
      addressJson,
      addr.pincode || addr.zip || null,
      totalPrice,
      productTitle || 'Store Product',
      variantId ? variantId.toString() : null,
      parseInt(quantity, 10) || 1,
      now,
      now
    );
  }

  // Record Stage 2: Lock Check
  const lockStart = Date.now();
  let existingOrder = sqlite.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(idempotencyKey);
  const lockCheckDuration = Math.max(1, Date.now() - lockStart);

  if (existingOrder) {
    console.log(`[Idempotency] Request with key ${idempotencyKey} detected. Current status: ${existingOrder.status}`);

    // If order was already successfully placed, return cached result immediately
    if (existingOrder.status === 'SUCCESS') {
      recordIdempotencyTrace({
        idempotencyKey,
        stepName: '3. DUPLICATE_CACHE_HIT (0ms Shopify Overhead)',
        status: 'REPLAY_SUCCESS',
        durationMs: 0,
        details: {
          shopifyOrderId: existingOrder.shopify_order_id,
          shopifyOrderNumber: existingOrder.shopify_order_number,
          message: 'Duplicate request safely absorbed. Existing order payload replayed.',
        },
      });

      return {
        success: true,
        statusCode: 200,
        isDuplicate: true,
        orderId: existingOrder.shopify_order_id,
        orderNumber: existingOrder.shopify_order_number,
        totalPrice: existingOrder.total_price,
        currency: existingOrder.currency,
        message: 'Order already confirmed. Returning existing order details.',
      };
    }

    // If order is currently in-flight, return 409 Conflict / In-Progress
    if (existingOrder.status === 'PROCESSING') {
      if (now - existingOrder.updated_at < 15000) {
        recordIdempotencyTrace({
          idempotencyKey,
          stepName: '3. CONCURRENT_IN_FLIGHT_BLOCKED',
          status: '409_CONFLICT',
          durationMs: 0,
          details: { message: 'Parallel request detected while first request is executing.' },
        });

        return {
          success: false,
          statusCode: 409,
          inFlight: true,
          error: 'An order submission is already in progress. Please wait a moment.',
        };
      }
    }

    // If previous attempt failed, allow retry
    sqlite.prepare(`
      UPDATE orders SET status = 'PROCESSING', updated_at = ? WHERE idempotency_key = ?
    `).run(now, idempotencyKey);

    recordIdempotencyTrace({
      idempotencyKey,
      stepName: '3. RETRY_LOCK_RE-ENGAGED',
      status: 'PROCESSING',
      durationMs: lockCheckDuration,
      details: { previousStatus: existingOrder.status },
    });
  } else {
    // 2. Insert new order record in PROCESSING state (Atomic Lock)
    const orderId = uuidv4();
    try {
      sqlite.prepare(`
        INSERT INTO orders (
          id, idempotency_key, session_id, status, customer_name,
          customer_phone, shipping_address, product_title, variant_id,
          quantity, total_price, cod_fee, currency, created_at, updated_at
        ) VALUES (?, ?, ?, 'PROCESSING', ?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?)
      `).run(
        orderId,
        idempotencyKey,
        sessionId,
        customerName,
        canonicalPhone,
        addressJson,
        productTitle || 'Store Product',
        variantId ? variantId.toString() : null,
        parseInt(quantity, 10) || 1,
        totalPrice,
        parseFloat(codFee) || 0,
        now,
        now
      );

      recordIdempotencyTrace({
        idempotencyKey,
        stepName: '3. ATOMIC_LOCK_ACQUIRED',
        status: 'PROCESSING',
        durationMs: lockCheckDuration,
        details: { orderId, lockState: 'PROCESSING' },
      });
    } catch (insertErr) {
      console.warn('[Idempotency Race Condition Handled]:', insertErr.message);
      const racedOrder = sqlite.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(idempotencyKey);
      if (racedOrder && racedOrder.status === 'SUCCESS') {
        recordIdempotencyTrace({
          idempotencyKey,
          stepName: '3. DUPLICATE_CACHE_HIT (Race Condition Absorbed)',
          status: 'REPLAY_SUCCESS',
          durationMs: 0,
          details: { shopifyOrderNumber: racedOrder.shopify_order_number },
        });

        return {
          success: true,
          statusCode: 200,
          isDuplicate: true,
          orderId: racedOrder.shopify_order_id,
          orderNumber: racedOrder.shopify_order_number,
          totalPrice: racedOrder.total_price,
          currency: racedOrder.currency,
        };
      }
      return {
        success: false,
        statusCode: 409,
        inFlight: true,
        error: 'Order is already being processed.',
      };
    }
  }

  // Record submit_clicked event in Funnel Stream
  recordFunnelEvent({
    sessionId,
    eventName: 'submit_clicked',
    shopDomain,
    payload: {
      idempotencyKey,
      customerName,
      customerPhone: canonicalPhone,
      cartTotal: totalPrice,
      quantity,
    },
    ipAddress,
    userAgent,
  });

  // Stage 4: Calling Shopify Admin API
  const shopifyCallStart = Date.now();
  recordIdempotencyTrace({
    idempotencyKey,
    stepName: '4. SHOPIFY_ADMIN_API_DISPATCH',
    status: 'DISPATCHED',
    durationMs: 0,
    details: { shopDomain, apiEndpoint: '/admin/api/2024-04/orders.json' },
  });

  const shopifyResult = await createShopifyOrder({
    shopDomain,
    customerName,
    customerPhone: canonicalPhone,
    shippingAddress,
    productTitle,
    variantId,
    quantity,
    unitPrice,
    codFee,
    sessionId,
    idempotencyKey,
    orderTag,
  });

  const shopifyLatency = Date.now() - shopifyCallStart;
  const completionTime = Date.now();

  // Stage 5 & 6: Handle Shopify Result & Commit
  if (shopifyResult.success) {
    sqlite.prepare(`
      UPDATE orders SET
        status = 'SUCCESS',
        shopify_order_id = ?,
        shopify_order_number = ?,
        total_price = ?,
        updated_at = ?
      WHERE idempotency_key = ?
    `).run(shopifyResult.orderId, shopifyResult.orderNumber, shopifyResult.totalPrice, completionTime, idempotencyKey);

    recordIdempotencyTrace({
      idempotencyKey,
      stepName: '5. SHOPIFY_CONFIRMED',
      status: 'CONFIRMED',
      durationMs: shopifyLatency,
      details: {
        shopifyOrderId: shopifyResult.orderId,
        orderNumber: shopifyResult.orderNumber,
        latencyMs: shopifyLatency,
      },
    });

    recordIdempotencyTrace({
      idempotencyKey,
      stepName: '6. DB_COMMITTED_SUCCESS',
      status: 'COMMITTED',
      durationMs: 2,
      details: { finalState: 'SUCCESS', funnelEvent: 'order_created' },
    });

    recordFunnelEvent({
      sessionId,
      eventName: 'order_created',
      shopDomain,
      payload: {
        orderId: shopifyResult.orderId,
        orderNumber: shopifyResult.orderNumber,
        totalPrice: shopifyResult.totalPrice,
      },
      ipAddress,
      userAgent,
    });

    return {
      success: true,
      statusCode: 201,
      orderId: shopifyResult.orderId,
      orderNumber: shopifyResult.orderNumber,
      totalPrice: shopifyResult.totalPrice,
      currency: shopifyResult.currency,
      customerPhone: canonicalPhone,
      message: 'Order placed successfully!',
    };
  }

  // Handle Timeout
  if (shopifyResult.isTimeout) {
    sqlite.prepare(`
      UPDATE orders SET
        status = 'TIMED_OUT',
        error_message = ?,
        updated_at = ?
      WHERE idempotency_key = ?
    `).run(shopifyResult.error, completionTime, idempotencyKey);

    recordIdempotencyTrace({
      idempotencyKey,
      stepName: '5. SHOPIFY_TIMED_OUT',
      status: 'TIMED_OUT',
      durationMs: shopifyLatency,
      details: { error: shopifyResult.error },
    });

    return {
      success: false,
      statusCode: 504,
      isTimeout: true,
      error: 'Order creation timed out on Shopify. Please check your order status before placing a new one.',
    };
  }

  // Handle Failure
  sqlite.prepare(`
    UPDATE orders SET
      status = 'FAILED',
      error_message = ?,
      updated_at = ?
    WHERE idempotency_key = ?
  `).run(shopifyResult.error, completionTime, idempotencyKey);

  recordIdempotencyTrace({
    idempotencyKey,
    stepName: '5. SHOPIFY_FAILED',
    status: 'FAILED',
    durationMs: shopifyLatency,
    details: { error: shopifyResult.error },
  });

  return {
    success: false,
    statusCode: shopifyResult.statusCode || 400,
    error: shopifyResult.error || 'Failed to place order on Shopify',
  };
}

module.exports = {
  processIdempotentCodOrder,
  recordIdempotencyTrace,
  getTracesForKey,
  getRecentIdempotencyTraces,
};
