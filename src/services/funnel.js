const { sqlite } = require('../db');
const { v4: uuidv4 } = require('uuid');
const { normalizeIndianPhone } = require('../utils/phone');

const FUNNEL_STEPS = [
  'form_opened',
  'phone_entered',
  'address_filled',
  'submit_clicked',
  'order_created',
];

/**
 * Record a funnel event for a session.
 * Deduplicates and updates session state accurately.
 */
function recordFunnelEvent({
  sessionId,
  eventName,
  shopDomain = 'daksh-cod-app.myshopify.com',
  payload = {},
  ipAddress = null,
  userAgent = null,
}) {
  if (!sessionId || !eventName) {
    throw new Error('sessionId and eventName are required');
  }

  const now = Date.now();

  // 1. Ensure session exists or create it
  let session = sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);

  if (!session) {
    sqlite.prepare(`
      INSERT INTO sessions (
        id, shop_domain, customer_name, customer_phone, customer_address,
        pincode, city, state, cart_total, product_id, product_title, variant_id,
        quantity, current_step, is_converted, ip_address, user_agent, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      sessionId,
      shopDomain,
      payload.customerName || null,
      payload.customerPhone ? normalizeIndianPhone(payload.customerPhone).canonical : null,
      payload.customerAddress ? JSON.stringify(payload.customerAddress) : null,
      payload.pincode || null,
      payload.city || null,
      payload.state || null,
      payload.cartTotal ? parseFloat(payload.cartTotal) : null,
      payload.productId || null,
      payload.productTitle || null,
      payload.variantId || null,
      payload.quantity ? parseInt(payload.quantity, 10) : 1,
      eventName,
      ipAddress,
      userAgent,
      now,
      now
    );
  } else {
    // Update session data if new payload info is provided
    const phoneNorm = payload.customerPhone ? normalizeIndianPhone(payload.customerPhone).canonical : session.customer_phone;
    const name = payload.customerName || session.customer_name;
    const address = payload.customerAddress ? JSON.stringify(payload.customerAddress) : session.customer_address;
    const pincode = payload.pincode || session.pincode;
    const city = payload.city || session.city;
    const state = payload.state || session.state;
    const cartTotal = payload.cartTotal ? parseFloat(payload.cartTotal) : session.cart_total;
    const productTitle = payload.productTitle || session.product_title;
    const isConverted = eventName === 'order_created' ? 1 : session.is_converted;

    sqlite.prepare(`
      UPDATE sessions SET
        customer_name = COALESCE(?, customer_name),
        customer_phone = COALESCE(?, customer_phone),
        customer_address = COALESCE(?, customer_address),
        pincode = COALESCE(?, pincode),
        city = COALESCE(?, city),
        state = COALESCE(?, state),
        cart_total = COALESCE(?, cart_total),
        product_title = COALESCE(?, product_title),
        current_step = ?,
        is_converted = ?,
        updated_at = ?
      WHERE id = ?
    `).run(name, phoneNorm, address, pincode, city, state, cartTotal, productTitle, eventName, isConverted, now, sessionId);
  }

  // 2. Insert event record in event stream
  const eventId = uuidv4();
  sqlite.prepare(`
    INSERT INTO funnel_events (id, session_id, event_name, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(eventId, sessionId, eventName, JSON.stringify(payload), now);

  return { success: true, eventId, sessionId, eventName };
}

/**
 * Get funnel analytics with step-by-step conversion and drop-off analysis.
 * Uses DISTINCT session_id to guarantee that retries / page reloads do not inflate counts.
 */
function getFunnelAnalytics(shopDomain = 'daksh-cod-app.myshopify.com', dateRange = '7d') {
  let startTime = 0;
  const now = Date.now();

  if (dateRange === 'today') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    startTime = today.getTime();
  } else if (dateRange === '7d') {
    startTime = now - 7 * 24 * 60 * 60 * 1000;
  } else if (dateRange === '30d') {
    startTime = now - 30 * 24 * 60 * 60 * 1000;
  }

  // Calculate distinct sessions per step
  const funnelData = [];
  let previousStepCount = null;
  let formOpenedCount = 0;
  let biggestDrop = { step: null, dropCount: 0, dropPercent: 0 };

  for (let i = 0; i < FUNNEL_STEPS.length; i++) {
    const step = FUNNEL_STEPS[i];
    let count = 0;

    if (step === 'order_created') {
      // TRUTHFUL GUARANTEE: Count distinct converted sessions from successful orders
      const orderCountResult = sqlite.prepare(`
        SELECT COUNT(DISTINCT o.session_id) as count
        FROM orders o
        JOIN sessions s ON o.session_id = s.id
        WHERE s.shop_domain = ? AND o.status = 'SUCCESS' AND o.created_at >= ?
      `).get(shopDomain, startTime);
      count = orderCountResult ? orderCountResult.count : 0;
    } else {
      // Count distinct sessions that reached this step
      const stepCountResult = sqlite.prepare(`
        SELECT COUNT(DISTINCT fe.session_id) as count
        FROM funnel_events fe
        JOIN sessions s ON fe.session_id = s.id
        WHERE s.shop_domain = ? AND fe.event_name = ? AND fe.created_at >= ?
      `).get(shopDomain, step, startTime);
      count = stepCountResult ? stepCountResult.count : 0;
    }

    if (i === 0) {
      formOpenedCount = count;
    }

    let conversionFromPrevious = 100;
    let dropOffFromPrevious = 0;
    let dropCount = 0;

    if (previousStepCount !== null) {
      if (previousStepCount > 0) {
        conversionFromPrevious = Math.min(100, Math.round((count / previousStepCount) * 1000) / 10);
        dropOffFromPrevious = Math.max(0, Math.round((100 - conversionFromPrevious) * 10) / 10);
        dropCount = Math.max(0, previousStepCount - count);
      } else {
        conversionFromPrevious = 0;
        dropOffFromPrevious = 0;
        dropCount = 0;
      }

      if (dropCount > biggestDrop.dropCount || (dropOffFromPrevious > biggestDrop.dropPercent && dropCount > 0)) {
        biggestDrop = {
          step: step,
          previousStep: FUNNEL_STEPS[i - 1],
          dropCount,
          dropPercent: dropOffFromPrevious,
        };
      }
    }

    const overallConversion = formOpenedCount > 0
      ? Math.round((count / formOpenedCount) * 1000) / 10
      : 0;

    funnelData.push({
      step,
      displayName: formatStepName(step),
      count,
      conversionFromPrevious: i === 0 ? 100 : conversionFromPrevious,
      dropOffFromPrevious: i === 0 ? 0 : dropOffFromPrevious,
      dropCount,
      overallConversion,
    });

    previousStepCount = count;
  }

  // Summary Metrics
  const totalSessions = formOpenedCount;
  const totalOrders = funnelData[funnelData.length - 1].count;
  const overallConversionRate = totalSessions > 0
    ? Math.round((totalOrders / totalSessions) * 1000) / 10
    : 0;

  return {
    shopDomain,
    dateRange,
    totalSessions,
    totalOrders,
    overallConversionRate,
    funnel: funnelData,
    biggestDropPoint: biggestDrop.step ? biggestDrop : null,
  };
}

/**
 * Get Abandoned Leads (Captured phone number but order was not completed)
 */
function getAbandonedLeads(shopDomain = 'daksh-cod-app.myshopify.com', limit = 50) {
  const abandonedRows = sqlite.prepare(`
    SELECT
      s.id as session_id,
      s.customer_name,
      s.customer_phone,
      s.pincode,
      s.city,
      s.state,
      s.cart_total,
      s.product_title,
      s.current_step,
      s.created_at,
      s.updated_at
    FROM sessions s
    WHERE s.shop_domain = ?
      AND s.is_converted = 0
      AND s.customer_phone IS NOT NULL
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).all(shopDomain, limit);

  return abandonedRows.map((lead) => {
    // Generate prefilled WhatsApp deep-link for 1-click recovery
    const phoneRaw = lead.customer_phone.replace('+', '');
    const custName = lead.customer_name ? lead.customer_name.split(' ')[0] : 'there';
    const prod = lead.product_title ? ` for "${lead.product_title}"` : '';
    const message = encodeURIComponent(
      `Hi ${custName}! We noticed you started placing a Cash on Delivery order${prod} on our store but didn't finish. Would you like us to confirm and dispatch your order today?`
    );
    const whatsappUrl = `https://wa.me/${phoneRaw}?text=${message}`;

    return {
      sessionId: lead.session_id,
      customerName: lead.customer_name || 'Anonymous Customer',
      customerPhone: lead.customer_phone,
      pincode: lead.pincode || 'N/A',
      city: lead.city || '',
      state: lead.state || '',
      cartTotal: lead.cart_total ? `₹${lead.cart_total.toFixed(2)}` : 'N/A',
      productTitle: lead.product_title || 'Store Product',
      lastStep: lead.current_step,
      lastStepDisplay: formatStepName(lead.current_step),
      abandonedAt: new Date(lead.updated_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      whatsappUrl,
    };
  });
}

function formatStepName(step) {
  switch (step) {
    case 'form_opened': return '1. Form Opened';
    case 'phone_entered': return '2. Phone Completed';
    case 'address_filled': return '3. Address Filled';
    case 'submit_clicked': return '4. Submit Clicked';
    case 'order_created': return '5. Order Confirmed';
    case 'otp_sent': return 'OTP Sent';
    case 'otp_verified': return 'OTP Verified';
    default: return step;
  }
}

module.exports = {
  recordFunnelEvent,
  getFunnelAnalytics,
  getAbandonedLeads,
  FUNNEL_STEPS,
};
