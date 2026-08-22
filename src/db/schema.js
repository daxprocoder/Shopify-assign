const { sqliteTable, text, integer, real } = require('drizzle-orm/sqlite-core');

// Sessions table: tracks every customer interaction session
const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), // UUID / Client session token
  shopDomain: text('shop_domain').notNull().default('daksh-cod-app.myshopify.com'),
  customerName: text('customer_name'),
  customerPhone: text('customer_phone'), // Canonical E.164 (+91XXXXXXXXXX)
  customerAddress: text('customer_address'), // JSON string of address details
  pincode: text('pincode'),
  city: text('city'),
  state: text('state'),
  cartTotal: real('cart_total'),
  productId: text('product_id'),
  productTitle: text('product_title'),
  variantId: text('variant_id'),
  quantity: integer('quantity').default(1),
  currentStep: text('current_step').default('form_opened'),
  isConverted: integer('is_converted', { mode: 'boolean' }).default(false),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Funnel Events table: immutable event stream
const funnelEvents = sqliteTable('funnel_events', {
  id: text('id').primaryKey(), // UUID
  sessionId: text('session_id').notNull().references(() => sessions.id),
  eventName: text('event_name').notNull(), // form_opened | phone_entered | address_filled | submit_clicked | order_created | otp_sent | otp_verified
  payload: text('payload'), // JSON metadata
  createdAt: integer('created_at').notNull(),
});

// Orders table: store orders with strict idempotency
const orders = sqliteTable('orders', {
  id: text('id').primaryKey(), // UUID
  idempotencyKey: text('idempotency_key').notNull().unique(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  shopifyOrderId: text('shopify_order_id'),
  shopifyOrderNumber: text('shopify_order_number'), // e.g. '#1001'
  status: text('status').notNull().default('PROCESSING'), // PROCESSING | SUCCESS | FAILED | TIMED_OUT
  customerName: text('customer_name').notNull(),
  customerPhone: text('customer_phone').notNull(),
  shippingAddress: text('shipping_address').notNull(), // JSON
  productTitle: text('product_title'),
  variantId: text('variant_id'),
  quantity: integer('quantity').default(1),
  totalPrice: real('total_price').notNull(),
  codFee: real('cod_fee').default(0),
  currency: text('currency').default('INR'),
  errorMessage: text('error_message'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Merchant Settings table
const merchantSettings = sqliteTable('merchant_settings', {
  shopDomain: text('shop_domain').primaryKey(),
  codFee: real('cod_fee').default(0), // Extra COD fee in INR
  pincodeBlocklist: text('pincode_blocklist').default(''), // Comma-separated or JSON list
  requireOtp: integer('require_otp', { mode: 'boolean' }).default(true), // Stretch goal: Mock OTP
  orderTag: text('order_tag').default('COD-Form'),
  minOrderValue: real('min_order_value').default(0),
  maxOrderValue: real('max_order_value').default(100000),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Mock OTP Verification Store
const otpVerifications = sqliteTable('otp_verifications', {
  phone: text('phone').primaryKey(), // Canonical phone
  code: text('code').notNull(),
  sessionId: text('session_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
  verified: integer('verified', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at').notNull(),
});

// Idempotency Waterfall Traces
const idempotencyTraces = sqliteTable('idempotency_traces', {
  id: text('id').primaryKey(),
  idempotencyKey: text('idempotency_key').notNull(),
  stepName: text('step_name').notNull(),
  status: text('status').notNull(),
  durationMs: integer('duration_ms').default(0),
  details: text('details'),
  createdAt: integer('created_at').notNull(),
});

// Webhook Audit Logs
const webhooks = sqliteTable('webhooks', {
  id: text('id').primaryKey(),
  topic: text('topic').notNull(),
  shopifyOrderId: text('shopify_order_id'),
  hmacValid: integer('hmac_valid', { mode: 'boolean' }).default(false),
  payload: text('payload'),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
});

module.exports = {
  sessions,
  funnelEvents,
  orders,
  merchantSettings,
  otpVerifications,
  idempotencyTraces,
  webhooks,
};
