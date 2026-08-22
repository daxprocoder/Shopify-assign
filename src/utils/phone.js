/**
 * Phone Number Validator & Canonical Normalizer for Indian Mobile Numbers.
 * Supports:
 *   "+91 98765 43210" -> "+919876543210"
 *   "919876543210"   -> "+919876543210"
 *   "9876543210"     -> "+919876543210"
 *   "09876543210"    -> "+919876543210"
 *   "+91-98765-43210"-> "+919876543210"
 */

function normalizeIndianPhone(input) {
  if (!input || typeof input !== 'string') {
    return {
      isValid: false,
      raw: input,
      canonical: null,
      national10: null,
      error: 'Phone number is required',
    };
  }

  // 1. Remove all non-digit characters except leading plus if any
  let cleaned = input.trim().replace(/[\s\-\(\)\.]/g, '');

  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  }

  // 2. Extract digits
  if (!/^\d+$/.test(cleaned)) {
    return {
      isValid: false,
      raw: input,
      canonical: null,
      national10: null,
      error: 'Phone number must only contain digits and optional country code',
    };
  }

  let national10 = null;

  if (cleaned.length === 10) {
    national10 = cleaned;
  } else if (cleaned.length === 11 && cleaned.startsWith('0')) {
    national10 = cleaned.substring(1);
  } else if (cleaned.length === 12 && cleaned.startsWith('91')) {
    national10 = cleaned.substring(2);
  } else if (cleaned.length === 13 && cleaned.startsWith('091')) {
    national10 = cleaned.substring(3);
  } else {
    return {
      isValid: false,
      raw: input,
      canonical: null,
      national10: null,
      error: 'Invalid length for Indian mobile number (must be 10 digits or include +91/0 prefix)',
    };
  }

  // 3. Indian mobile numbers must begin with 6, 7, 8, or 9
  if (!/^[6-9]\d{9}$/.test(national10)) {
    return {
      isValid: false,
      raw: input,
      canonical: null,
      national10: null,
      error: 'Indian mobile numbers must begin with digits 6, 7, 8, or 9',
    };
  }

  // Canonical E.164 format: +91XXXXXXXXXX
  const canonical = `+91${national10}`;

  return {
    isValid: true,
    raw: input,
    canonical,
    national10,
    error: null,
  };
}

module.exports = {
  normalizeIndianPhone,
};
