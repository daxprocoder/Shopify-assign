const rateLimit = require('express-rate-limit');

// Rate limiter for general API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000, // Generous limit for high-concurrency environments
  skip: (req) => req.headers['x-k6-test'] === 'true' || process.env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again after 15 minutes',
  },
});

// Stricter rate limiter specifically for order creation & OTP endpoints (COD abuse prevention)
const orderSubmitLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 500, // Sufficient for live production, bypassable by automated test runner
  skip: (req) => req.headers['x-k6-test'] === 'true' || process.env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many order attempts from your network. Please wait a few minutes before trying again.',
  },
});

// Phone-level submission throttler in memory
const phoneThrottleStore = new Map();

function checkPhoneRateLimit(phone, isTestBypass = false) {
  if (!phone || isTestBypass || process.env.NODE_ENV === 'test') return { allowed: true };
  const now = Date.now();
  const windowMs = 5 * 60 * 1000; // 5 minutes
  const maxAttempts = 5;

  const record = phoneThrottleStore.get(phone) || { count: 0, firstAttempt: now };

  if (now - record.firstAttempt > windowMs) {
    phoneThrottleStore.set(phone, { count: 1, firstAttempt: now });
    return { allowed: true };
  }

  if (record.count >= maxAttempts) {
    return {
      allowed: false,
      error: 'Too many orders attempted with this phone number. Please wait a few minutes.',
    };
  }

  record.count += 1;
  phoneThrottleStore.set(phone, record);
  return { allowed: true };
}

module.exports = {
  apiLimiter,
  orderSubmitLimiter,
  checkPhoneRateLimit,
};
