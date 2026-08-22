const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const path = require('path');
const schema = require('./schema');

const dbPath = path.resolve(__dirname, '../../cod_app.db');
const sqlite = new Database(dbPath);

// Enable WAL mode for better concurrency and performance
sqlite.pragma('journal_mode = WAL');

const db = drizzle(sqlite, { schema });

// Initialize tables if they do not exist
function initDb() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      shop_domain TEXT NOT NULL DEFAULT 'daksh-cod-app.myshopify.com',
      customer_name TEXT,
      customer_phone TEXT,
      customer_address TEXT,
      pincode TEXT,
      city TEXT,
      state TEXT,
      cart_total REAL,
      product_id TEXT,
      product_title TEXT,
      variant_id TEXT,
      quantity INTEGER DEFAULT 1,
      current_step TEXT DEFAULT 'form_opened',
      is_converted INTEGER DEFAULT 0,
      ip_address TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS funnel_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions (id)
    );

    CREATE INDEX IF NOT EXISTS idx_funnel_session_event ON funnel_events (session_id, event_name);
    CREATE INDEX IF NOT EXISTS idx_funnel_created_at ON funnel_events (created_at);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      shopify_order_id TEXT,
      shopify_order_number TEXT,
      status TEXT NOT NULL DEFAULT 'PROCESSING',
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      shipping_address TEXT NOT NULL,
      product_title TEXT,
      variant_id TEXT,
      quantity INTEGER DEFAULT 1,
      total_price REAL NOT NULL,
      cod_fee REAL DEFAULT 0,
      currency TEXT DEFAULT 'INR',
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions (id)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_idempotency ON orders (idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_orders_session ON orders (session_id);

    CREATE TABLE IF NOT EXISTS merchant_settings (
      shop_domain TEXT PRIMARY KEY,
      cod_fee REAL DEFAULT 0,
      pincode_blocklist TEXT DEFAULT '',
      require_otp INTEGER DEFAULT 1,
      order_tag TEXT DEFAULT 'COD-Form',
      min_order_value REAL DEFAULT 0,
      max_order_value REAL DEFAULT 100000,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otp_verifications (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      session_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      verified INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);

  // Seed default merchant settings for the shop domain if not present
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN || 'daksh-cod-app.myshopify.com';
  const existingSettings = sqlite.prepare('SELECT * FROM merchant_settings WHERE shop_domain = ?').get(shopDomain);
  if (!existingSettings) {
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO merchant_settings (shop_domain, cod_fee, pincode_blocklist, require_otp, order_tag, min_order_value, max_order_value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(shopDomain, 49.0, '110006,700001,800001', 1, 'COD-Form', 0, 50000, now, now);
    console.log(`[DB] Initialized default settings for ${shopDomain}`);
  }
}

initDb();

module.exports = {
  db,
  sqlite,
  schema,
};
