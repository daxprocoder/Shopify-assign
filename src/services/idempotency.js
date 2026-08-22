const { sqlite } = require('../db');
const { v4: uuidv4 } = require('uuid');
const { createShopifyOrder } = require('./shopify');
const { recordFunnelEvent } = require('./funnel');
const { normalizeIndianPhone } = require('../utils/phone');

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

  // 1. Check if an order record already exists for this idempotency key
  let existingOrder = sqlite.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(idempotencyKey);

  if (existingOrder) {
    console.log(`[Idempotency] Request with key ${idempotencyKey} detected. Current status: ${existingOrder.status}`);

    // If order was already successfully placed, return the existing order details
    if (existingOrder.status === 'SUCCESS') {
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

    // If order is currently in-flight, return 409 Conflict / In-Progress to prevent duplicate calls
    if (existingOrder.status === 'PROCESSING') {
      // Check if it's been processing for less than 15 seconds
      if (now - existingOrder.updated_at < 15000) {
        return {
          success: false,
          statusCode: 409,
          inFlight: true,
          error: 'An order submission is already in progress. Please wait a moment.',
        };
      }
      // If older than 15s, treat as timed-out retry
    }

    // If previous attempt failed, update state to PROCESSING to allow retry
    sqlite.prepare(`
      UPDATE orders SET status = 'PROCESSING', updated_at = ? WHERE idempotency_key = ?
    `).run(now, idempotencyKey);
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
    } catch (insertErr) {
      // Race condition catch: another worker inserted the same idempotency key simultaneously
      console.warn('[Idempotency Race Condition Handled]:', insertErr.message);
      const racedOrder = sqlite.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(idempotencyKey);
      if (racedOrder && racedOrder.status === 'SUCCESS') {
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

  // 3. Execute Order Creation with Shopify Admin API
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

  const completionTime = Date.now();

  // 4. Handle Shopify Result
  if (shopifyResult.success) {
    // Update Order to SUCCESS
    sqlite.prepare(`
      UPDATE orders SET
        status = 'SUCCESS',
        shopify_order_id = ?,
        shopify_order_number = ?,
        total_price = ?,
        updated_at = ?
      WHERE idempotency_key = ?
    `).run(shopifyResult.orderId, shopifyResult.orderNumber, shopifyResult.totalPrice, completionTime, idempotencyKey);

    // Record order_created event in Funnel Stream
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

  // Handle Failure / Timeout
  if (shopifyResult.isTimeout) {
    sqlite.prepare(`
      UPDATE orders SET
        status = 'TIMED_OUT',
        error_message = ?,
        updated_at = ?
      WHERE idempotency_key = ?
    `).run(shopifyResult.error, completionTime, idempotencyKey);

    return {
      success: false,
      statusCode: 504,
      isTimeout: true,
      error: 'Order creation timed out on Shopify. Please check your order status before placing a new one.',
    };
  }

  // Update Order to FAILED
  sqlite.prepare(`
    UPDATE orders SET
      status = 'FAILED',
      error_message = ?,
      updated_at = ?
    WHERE idempotency_key = ?
  `).run(shopifyResult.error, completionTime, idempotencyKey);

  return {
    success: false,
    statusCode: shopifyResult.statusCode || 400,
    error: shopifyResult.error || 'Failed to place order on Shopify',
  };
}

module.exports = {
  processIdempotentCodOrder,
};
