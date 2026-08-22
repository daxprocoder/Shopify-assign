const crypto = require('crypto');

/**
 * Verify Shopify Webhook HMAC-SHA256 signature.
 * @param {Buffer|string} rawBody - The raw request body buffer or string.
 * @param {string} hmacHeader - The value of 'x-shopify-hmac-sha256' header.
 * @param {string} secret - The Shopify API secret / Webhook secret.
 * @returns {boolean} True if signature matches, false otherwise.
 */
function verifyShopifyHmac(rawBody, hmacHeader, secret = process.env.SHOPIFY_API_SECRET || 'shopify_webhook_secret_dev') {
  if (!rawBody || !hmacHeader) {
    return false;
  }

  try {
    const generatedHmac = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    const generatedBuffer = Buffer.from(generatedHmac, 'utf8');
    const headerBuffer = Buffer.from(hmacHeader.trim(), 'utf8');

    if (generatedBuffer.length !== headerBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(generatedBuffer, headerBuffer);
  } catch (err) {
    console.error('[HMAC Verification Error]:', err);
    return false;
  }
}

/**
 * Generate a test HMAC signature for simulated webhooks / unit tests.
 */
function generateTestHmac(bodyString, secret = process.env.SHOPIFY_API_SECRET || 'shopify_webhook_secret_dev') {
  return crypto
    .createHmac('sha256', secret)
    .update(bodyString)
    .digest('base64');
}

module.exports = {
  verifyShopifyHmac,
  generateTestHmac,
};
