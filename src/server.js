require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { sqlite } = require('./db');
const { normalizeIndianPhone } = require('./utils/phone');
const { apiLimiter, orderSubmitLimiter, checkPhoneRateLimit } = require('./utils/rate-limiter');
const { recordFunnelEvent, getFunnelAnalytics, getAbandonedLeads } = require('./services/funnel');
const { generateAndSendOtp, verifyOtp } = require('./services/otp');
const { processIdempotentCodOrder } = require('./services/idempotency');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_SHOP = process.env.SHOPIFY_SHOP_DOMAIN || 'daksh-cod-app.myshopify.com';

// Middlewares
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(apiLimiter);

// Serve static assets (Dashboard UI & Storefront scripts)
app.use('/static', express.static(path.join(__dirname, '../public')));
app.use('/storefront', express.static(path.join(__dirname, '../public/storefront')));

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (!req.path.startsWith('/static') && !req.path.startsWith('/storefront')) {
      console.log(`[HTTP] ${req.method} ${req.path} ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// ==========================================
// 1. STOREFRONT COD API ENDPOINTS
// ==========================================

/**
 * GET /api/cod/settings
 * Fetch merchant settings for storefront rendering (COD fee, blocked pincodes, OTP requirement)
 */
app.get('/api/cod/settings', (req, res) => {
  const shop = req.query.shop || DEFAULT_SHOP;
  const settings = sqlite.prepare('SELECT * FROM merchant_settings WHERE shop_domain = ?').get(shop);

  if (!settings) {
    return res.json({
      success: true,
      settings: {
        shopDomain: shop,
        codFee: 0,
        pincodeBlocklist: [],
        requireOtp: true,
        orderTag: 'COD-Form',
        minOrderValue: 0,
        maxOrderValue: 50000,
      },
    });
  }

  const blocklist = settings.pincode_blocklist
    ? settings.pincode_blocklist.split(',').map((p) => p.trim()).filter(Boolean)
    : [];

  res.json({
    success: true,
    settings: {
      shopDomain: settings.shop_domain,
      codFee: settings.cod_fee,
      pincodeBlocklist: blocklist,
      requireOtp: Boolean(settings.require_otp),
      orderTag: settings.order_tag,
      minOrderValue: settings.min_order_value,
      maxOrderValue: settings.max_order_value,
    },
  });
});

/**
 * POST /api/cod/session
 * Initialize or retrieve a customer checkout session
 */
app.post('/api/cod/session', (req, res) => {
  const { sessionId, shopDomain = DEFAULT_SHOP, productDetails = {} } = req.body;
  const activeSessionId = sessionId || uuidv4();

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];

  // Record initial form_opened event
  recordFunnelEvent({
    sessionId: activeSessionId,
    eventName: 'form_opened',
    shopDomain,
    payload: {
      productId: productDetails.productId,
      productTitle: productDetails.productTitle,
      variantId: productDetails.variantId,
      cartTotal: productDetails.price,
      quantity: productDetails.quantity || 1,
    },
    ipAddress: ip,
    userAgent,
  });

  res.json({
    success: true,
    sessionId: activeSessionId,
    idempotencyKey: `idem_${activeSessionId}_${Date.now()}`,
  });
});

/**
 * POST /api/cod/event
 * Ingest live customer funnel events (form_opened, phone_entered, address_filled, etc.)
 */
app.post('/api/cod/event', (req, res) => {
  const { sessionId, eventName, shopDomain = DEFAULT_SHOP, payload = {} } = req.body;

  if (!sessionId || !eventName) {
    return res.status(400).json({ success: false, error: 'sessionId and eventName are required' });
  }

  // If phone is provided in payload, validate and normalize
  if (payload.customerPhone) {
    const phoneNorm = normalizeIndianPhone(payload.customerPhone);
    if (!phoneNorm.isValid && eventName === 'phone_entered') {
      return res.status(400).json({ success: false, error: phoneNorm.error });
    }
    payload.customerPhone = phoneNorm.canonical;
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];

  const result = recordFunnelEvent({
    sessionId,
    eventName,
    shopDomain,
    payload,
    ipAddress: ip,
    userAgent,
  });

  res.json(result);
});

/**
 * POST /api/cod/otp/send
 * Mock OTP sender (logs to server console & records otp_sent event)
 */
app.post('/api/cod/otp/send', (req, res) => {
  const { phone, sessionId, shopDomain = DEFAULT_SHOP } = req.body;

  if (!phone || !sessionId) {
    return res.status(400).json({ success: false, error: 'Phone number and sessionId are required' });
  }

  // Rate limit phone attempts
  const throttle = checkPhoneRateLimit(phone);
  if (!throttle.allowed) {
    return res.status(429).json({ success: false, error: throttle.error });
  }

  try {
    const otpResult = generateAndSendOtp(phone, sessionId);

    // Record otp_sent funnel event
    recordFunnelEvent({
      sessionId,
      eventName: 'otp_sent',
      shopDomain,
      payload: { customerPhone: otpResult.phone },
    });

    res.json(otpResult);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/cod/otp/verify
 * Mock OTP verification (validates code & records otp_verified event)
 */
app.post('/api/cod/otp/verify', (req, res) => {
  const { phone, code, sessionId, shopDomain = DEFAULT_SHOP } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ success: false, error: 'Phone and OTP code are required' });
  }

  const verifyResult = verifyOtp(phone, code);

  if (verifyResult.success && sessionId) {
    recordFunnelEvent({
      sessionId,
      eventName: 'otp_verified',
      shopDomain,
      payload: { customerPhone: phone },
    });
  }

  if (!verifyResult.success) {
    return res.status(400).json(verifyResult);
  }

  res.json(verifyResult);
});

/**
 * POST /api/cod/order
 * Create Shopify COD Order with strict Idempotency and Concurrency Lock
 */
app.post('/api/cod/order', orderSubmitLimiter, async (req, res) => {
  const {
    idempotencyKey,
    sessionId,
    shopDomain = DEFAULT_SHOP,
    customerName,
    customerPhone,
    shippingAddress,
    productTitle,
    variantId,
    quantity = 1,
    unitPrice = 0,
    codFee = 0,
  } = req.body;

  if (!idempotencyKey || !sessionId) {
    return res.status(400).json({ success: false, error: 'idempotencyKey and sessionId are required' });
  }

  if (!customerName || !customerPhone || !shippingAddress) {
    return res.status(400).json({ success: false, error: 'Customer name, phone, and address are required' });
  }

  // Pincode blocklist check against merchant settings
  const settings = sqlite.prepare('SELECT * FROM merchant_settings WHERE shop_domain = ?').get(shopDomain);
  const addr = typeof shippingAddress === 'string' ? JSON.parse(shippingAddress) : shippingAddress;
  const pincode = addr.pincode || addr.zip;

  if (settings && settings.pincode_blocklist && pincode) {
    const blockedPins = settings.pincode_blocklist.split(',').map((p) => p.trim());
    if (blockedPins.includes(pincode.trim())) {
      return res.status(400).json({
        success: false,
        error: `Cash on Delivery is currently unavailable for pincode ${pincode}. Please choose another address.`,
      });
    }
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];

  const orderResult = await processIdempotentCodOrder({
    idempotencyKey,
    sessionId,
    shopDomain,
    customerName,
    customerPhone,
    shippingAddress: addr,
    productTitle,
    variantId,
    quantity,
    unitPrice,
    codFee: settings ? settings.cod_fee : codFee,
    orderTag: settings ? settings.order_tag : 'COD-Form',
    ipAddress: ip,
    userAgent,
  });

  return res.status(orderResult.statusCode || 200).json(orderResult);
});

// ==========================================
// 2. MERCHANT DASHBOARD API ENDPOINTS
// ==========================================

/**
 * GET /api/dashboard/funnel
 * Return truthful funnel analytics, step-by-step conversion, and biggest drop point
 */
app.get('/api/dashboard/funnel', (req, res) => {
  const shop = req.query.shop || DEFAULT_SHOP;
  const dateRange = req.query.range || '7d'; // 'today' | '7d' | '30d'

  const analytics = getFunnelAnalytics(shop, dateRange);
  res.json(analytics);
});

/**
 * GET /api/dashboard/orders
 * Return real COD orders placed via the app
 */
app.get('/api/dashboard/orders', (req, res) => {
  const shop = req.query.shop || DEFAULT_SHOP;
  const limit = parseInt(req.query.limit, 10) || 50;

  const ordersList = sqlite.prepare(`
    SELECT
      o.id,
      o.idempotency_key,
      o.shopify_order_id,
      o.shopify_order_number,
      o.status,
      o.customer_name,
      o.customer_phone,
      o.shipping_address,
      o.product_title,
      o.quantity,
      o.total_price,
      o.cod_fee,
      o.currency,
      o.error_message,
      o.created_at
    FROM orders o
    JOIN sessions s ON o.session_id = s.id
    WHERE s.shop_domain = ?
    ORDER BY o.created_at DESC
    LIMIT ?
  `).all(shop, limit);

  const formatted = ordersList.map((ord) => {
    let addrObj = {};
    try {
      addrObj = JSON.parse(ord.shipping_address);
    } catch (_) {}

    const shopDomain = shop.replace('.myshopify.com', '');
    const adminLink = ord.shopify_order_id
      ? `https://admin.shopify.com/store/${shopDomain}/orders/${ord.shopify_order_id}`
      : null;

    return {
      id: ord.id,
      orderNumber: ord.shopify_order_number || 'N/A',
      status: ord.status,
      customerName: ord.customer_name,
      customerPhone: ord.customer_phone,
      addressSummary: `${addrObj.address1 || ''}, ${addrObj.city || ''} (${addrObj.pincode || ''})`,
      productTitle: ord.product_title,
      quantity: ord.quantity,
      totalPrice: `₹${ord.total_price.toFixed(2)}`,
      codFee: `₹${ord.cod_fee.toFixed(2)}`,
      createdAt: new Date(ord.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      adminLink,
      idempotencyKey: ord.idempotency_key,
    };
  });

  res.json({ success: true, orders: formatted });
});

/**
 * GET /api/dashboard/abandoned
 * Return abandoned leads (customer phone captured, but order was not completed)
 */
app.get('/api/dashboard/abandoned', (req, res) => {
  const shop = req.query.shop || DEFAULT_SHOP;
  const leads = getAbandonedLeads(shop, 50);
  res.json({ success: true, abandonedLeads: leads });
});

/**
 * POST /api/dashboard/settings
 * Update merchant settings (COD extra fee, blocked pincodes, requireOtp, orderTag)
 */
app.post('/api/dashboard/settings', (req, res) => {
  const {
    shopDomain = DEFAULT_SHOP,
    codFee = 0,
    pincodeBlocklist = '',
    requireOtp = true,
    orderTag = 'COD-Form',
    minOrderValue = 0,
    maxOrderValue = 50000,
  } = req.body;

  const now = Date.now();
  const blocklistString = Array.isArray(pincodeBlocklist)
    ? pincodeBlocklist.join(',')
    : (pincodeBlocklist || '').toString();

  sqlite.prepare(`
    INSERT INTO merchant_settings (
      shop_domain, cod_fee, pincode_blocklist, require_otp, order_tag, min_order_value, max_order_value, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_domain) DO UPDATE SET
      cod_fee = excluded.cod_fee,
      pincode_blocklist = excluded.pincode_blocklist,
      require_otp = excluded.require_otp,
      order_tag = excluded.order_tag,
      min_order_value = excluded.min_order_value,
      max_order_value = excluded.max_order_value,
      updated_at = excluded.updated_at
  `).run(
    shopDomain,
    parseFloat(codFee) || 0,
    blocklistString,
    requireOtp ? 1 : 0,
    orderTag || 'COD-Form',
    parseFloat(minOrderValue) || 0,
    parseFloat(maxOrderValue) || 50000,
    now,
    now
  );

  console.log(`[Merchant Settings] Updated settings for ${shopDomain}: COD Fee=₹${codFee}, Blocklist=${blocklistString}, OTP=${requireOtp}`);

  res.json({
    success: true,
    message: 'Merchant settings saved successfully',
  });
});

// Serve Single Page Application / Dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// Interactive Product Page Demo (Simulates live Shopify PDP)
app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/demo.html'));
});

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n=================================================`);
    console.log(`🚀 Shopify COD Order Form App Server Running!`);
    console.log(`📍 Local Port: http://localhost:${PORT}`);
    console.log(`📊 Merchant Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`🛍️ Storefront PDP Demo: http://localhost:${PORT}/demo`);
    console.log(`🏪 Connected Shop: ${DEFAULT_SHOP}`);
    console.log(`=================================================\n`);
  });
}

module.exports = app;
