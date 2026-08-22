(function () {
  'use strict';

  // Config & State
  const API_BASE = window.COD_APP_API_BASE || (window.location.origin.includes('localhost') ? window.location.origin : '');
  const SHOP_DOMAIN = window.Shopify && window.Shopify.shop ? window.Shopify.shop : 'daksh-cod-app.myshopify.com';

  let sessionId = 'sess_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
  let idempotencyKey = 'idem_' + sessionId + '_' + Date.now();

  let state = {
    settings: {
      codFee: 0,
      pincodeBlocklist: [],
      requireOtp: false,
    },
    product: {
      title: 'Sample Product',
      price: 999,
      variantId: null,
      quantity: 1,
    },
    eventsFired: {
      form_opened: false,
      phone_entered: false,
      address_filled: false,
      submit_clicked: false,
      order_created: false,
    },
    otpState: {
      sent: false,
      verified: false,
      code: '',
    },
  };

  // Helper: Indian Phone Validator & Normalizer
  function validateAndNormalizePhone(raw) {
    if (!raw) return { isValid: false, canonical: '' };
    let cleaned = raw.trim().replace(/[\s\-\(\)\.]/g, '');
    if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);
    if (!/^\d+$/.test(cleaned)) return { isValid: false, canonical: '' };

    let national10 = '';
    if (cleaned.length === 10) national10 = cleaned;
    else if (cleaned.length === 11 && cleaned.startsWith('0')) national10 = cleaned.substring(1);
    else if (cleaned.length === 12 && cleaned.startsWith('91')) national10 = cleaned.substring(2);
    else if (cleaned.length === 13 && cleaned.startsWith('091')) national10 = cleaned.substring(3);
    else return { isValid: false, canonical: '' };

    if (!/^[6-9]\d{9}$/.test(national10)) return { isValid: false, canonical: '' };

    return { isValid: true, canonical: '+91' + national10, national10 };
  }

  // API Call helper
  async function apiCall(endpoint, method = 'GET', data = null) {
    try {
      const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (data) options.body = JSON.stringify(data);
      const res = await fetch(API_BASE + endpoint, options);
      const json = await res.json();
      return { ok: res.ok, status: res.status, data: json };
    } catch (err) {
      console.error('[COD Form Error]:', err);
      return { ok: false, status: 0, data: { error: err.message || 'Network error' } };
    }
  }

  // Send Funnel Event to Server
  async function emitFunnelEvent(eventName, payload = {}) {
    console.log(`[COD Funnel] Emitting: ${eventName}`, payload);
    return apiCall('/api/cod/event', 'POST', {
      sessionId,
      eventName,
      shopDomain: SHOP_DOMAIN,
      payload,
    });
  }

  // Fetch Merchant Settings
  async function loadSettings() {
    const res = await apiCall(`/api/cod/settings?shop=${encodeURIComponent(SHOP_DOMAIN)}`);
    if (res.ok && res.data.settings) {
      state.settings = res.data.settings;
      console.log('[COD Settings Loaded]:', state.settings);
    }
  }

  // Build and inject modal DOM
  function createModalDOM() {
    if (document.getElementById('cod-modal-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'cod-modal-overlay';
    overlay.className = 'cod-modal-overlay';

    overlay.innerHTML = `
      <div class="cod-modal-card" role="dialog" aria-modal="true">
        <div class="cod-modal-header">
          <h3 class="cod-modal-title">⚡ Quick Cash on Delivery Checkout</h3>
          <button type="button" class="cod-close-btn" id="cod-modal-close" aria-label="Close">&times;</button>
        </div>

        <div class="cod-product-bar">
          <div class="cod-product-info">
            <span class="cod-prod-name" id="cod-modal-prod-title">Product Title</span>
            <span class="cod-prod-qty" id="cod-modal-prod-qty">Qty: 1</span>
          </div>
          <div class="cod-prod-price" id="cod-modal-prod-price">₹999.00</div>
        </div>

        <div class="cod-modal-body">
          <div id="cod-global-alert" class="cod-alert"></div>

          <form id="cod-checkout-form" novalidate>
            <!-- Step 1: Customer Contact -->
            <div class="cod-form-group">
              <label class="cod-label" for="cod-name">Full Name *</label>
              <input type="text" id="cod-name" class="cod-input" placeholder="e.g. Rahul Sharma" required />
            </div>

            <div class="cod-form-group">
              <label class="cod-label" for="cod-phone">Mobile Number (India) *</label>
              <div style="position: relative;">
                <input type="tel" id="cod-phone" class="cod-input" placeholder="+91 98765 43210" required />
                <span id="cod-phone-status" style="position: absolute; right: 10px; top: 10px; font-size: 13px; font-weight: 600;"></span>
              </div>
              <div class="cod-field-error" id="cod-phone-error">Please enter a valid 10-digit Indian mobile number.</div>
            </div>

            <!-- Step 2: Delivery Address -->
            <div class="cod-form-group">
              <label class="cod-label" for="cod-address">Street Address / House No / Area *</label>
              <input type="text" id="cod-address" class="cod-input" placeholder="Flat / House No., Landmark, Street" required />
            </div>

            <div class="cod-row-2">
              <div class="cod-form-group">
                <label class="cod-label" for="cod-pincode">Pincode *</label>
                <input type="text" id="cod-pincode" class="cod-input" placeholder="6-digit PIN" maxlength="6" required />
                <div class="cod-field-error" id="cod-pincode-error"></div>
              </div>
              <div class="cod-form-group">
                <label class="cod-label" for="cod-city">City *</label>
                <input type="text" id="cod-city" class="cod-input" placeholder="e.g. Mumbai" required />
              </div>
            </div>

            <div class="cod-form-group">
              <label class="cod-label" for="cod-state">State *</label>
              <input type="text" id="cod-state" class="cod-input" placeholder="e.g. Maharashtra" required />
            </div>

            <!-- Step 3: Mock OTP Verification (if enabled) -->
            <div id="cod-otp-container" class="cod-otp-box" style="display: none;">
              <div style="font-size: 13px; font-weight: 600; margin-bottom: 6px;">📱 SMS OTP Verification</div>
              <div style="font-size: 12px; color: #64748b; margin-bottom: 8px;">A 6-digit verification code will be sent to your mobile.</div>
              <div id="cod-otp-action-row" style="display: flex; gap: 8px;">
                <button type="button" id="cod-send-otp-btn" class="cod-btn-secondary">Send OTP Code</button>
              </div>
              <div id="cod-otp-verify-row" style="display: none; margin-top: 10px; gap: 8px;">
                <input type="text" id="cod-otp-input" class="cod-input" placeholder="Enter 6-digit OTP" style="max-width: 160px;" maxlength="6" />
                <button type="button" id="cod-verify-otp-btn" class="cod-btn-secondary" style="background: #108043; color: #fff;">Verify</button>
              </div>
              <div id="cod-otp-hint" style="font-size: 11.5px; color: #0284c7; margin-top: 6px; display: none;"></div>
            </div>

            <!-- Summary & Pricing -->
            <div class="cod-price-summary">
              <div class="cod-summary-row">
                <span>Product Price:</span>
                <span id="cod-summary-item-price">₹0.00</span>
              </div>
              <div class="cod-summary-row">
                <span>COD Handling Fee:</span>
                <span id="cod-summary-fee">₹0.00</span>
              </div>
              <div class="cod-summary-row total">
                <span>Total Amount Due on Delivery:</span>
                <span id="cod-summary-total">₹0.00</span>
              </div>
            </div>

            <!-- Submit Button -->
            <button type="submit" id="cod-submit-order-btn" class="cod-submit-btn">
              <span>Complete Cash on Delivery Order 📦</span>
            </button>
          </form>

          <!-- Success Confirmation View -->
          <div id="cod-success-container" class="cod-success-view" style="display: none;">
            <div class="cod-success-icon">✓</div>
            <h3 style="margin: 0; color: #166534; font-size: 20px;">Order Placed Successfully!</h3>
            <p style="color: #64748b; font-size: 13.5px; margin: 6px 0;">Your Cash-on-Delivery order is confirmed and being prepared for dispatch.</p>
            <div class="cod-order-number-badge" id="cod-confirmed-order-number">Order #1001</div>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-top: 14px; text-align: left; font-size: 13px;">
              <div><strong>Deliver to:</strong> <span id="cod-confirmed-name"></span></div>
              <div style="margin-top: 4px;"><strong>Contact:</strong> <span id="cod-confirmed-phone"></span></div>
              <div style="margin-top: 4px;"><strong>Payable on Delivery:</strong> <span id="cod-confirmed-total" style="color: #108043; font-weight: 700;"></span></div>
            </div>
            <button type="button" class="cod-btn-secondary" id="cod-done-btn" style="margin-top: 18px; width: 100%; padding: 12px;">Close</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    setupEventListeners();
  }

  // Setup Event Listeners
  function setupEventListeners() {
    const overlay = document.getElementById('cod-modal-overlay');
    const closeBtn = document.getElementById('cod-modal-close');
    const doneBtn = document.getElementById('cod-done-btn');
    const form = document.getElementById('cod-checkout-form');
    const nameInput = document.getElementById('cod-name');
    const phoneInput = document.getElementById('cod-phone');
    const addressInput = document.getElementById('cod-address');
    const pincodeInput = document.getElementById('cod-pincode');
    const cityInput = document.getElementById('cod-city');
    const stateInput = document.getElementById('cod-state');
    const sendOtpBtn = document.getElementById('cod-send-otp-btn');
    const verifyOtpBtn = document.getElementById('cod-verify-otp-btn');
    const otpInput = document.getElementById('cod-otp-input');

    // Close handlers
    closeBtn.addEventListener('click', closeModal);
    doneBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    // 1. Phone number validation & Funnel Event: `phone_entered`
    let phoneDebounceTimer;
    phoneInput.addEventListener('input', () => {
      clearTimeout(phoneDebounceTimer);
      phoneDebounceTimer = setTimeout(() => {
        handlePhoneValidation(phoneInput.value);
      }, 500);
    });

    phoneInput.addEventListener('blur', () => {
      handlePhoneValidation(phoneInput.value);
    });

    function handlePhoneValidation(val) {
      const statusEl = document.getElementById('cod-phone-status');
      const errorEl = document.getElementById('cod-phone-error');
      const phoneRes = validateAndNormalizePhone(val);

      if (phoneRes.isValid) {
        phoneInput.classList.remove('invalid');
        errorEl.style.display = 'none';
        statusEl.textContent = '✓ ' + phoneRes.canonical;
        statusEl.style.color = '#16a34a';

        // Fire `phone_entered` ONCE per valid phone entry
        if (!state.eventsFired.phone_entered) {
          state.eventsFired.phone_entered = true;
          emitFunnelEvent('phone_entered', {
            customerName: nameInput.value,
            customerPhone: phoneRes.canonical,
            cartTotal: calculateTotal(),
          });
        }
      } else if (val.trim().length > 0) {
        phoneInput.classList.add('invalid');
        errorEl.style.display = 'block';
        statusEl.textContent = '';
      } else {
        phoneInput.classList.remove('invalid');
        errorEl.style.display = 'none';
        statusEl.textContent = '';
      }
    }

    // 2. Address & Pincode completion -> Funnel Event: `address_filled`
    const addressFields = [addressInput, pincodeInput, cityInput, stateInput];
    addressFields.forEach((field) => {
      field.addEventListener('blur', checkAddressFilled);
    });

    pincodeInput.addEventListener('input', () => {
      const pin = pincodeInput.value.trim();
      const pinErrorEl = document.getElementById('cod-pincode-error');
      if (state.settings.pincodeBlocklist && state.settings.pincodeBlocklist.includes(pin)) {
        pincodeInput.classList.add('invalid');
        pinErrorEl.textContent = `❌ COD is blocked for pincode ${pin}`;
        pinErrorEl.style.display = 'block';
      } else {
        pincodeInput.classList.remove('invalid');
        pinErrorEl.style.display = 'none';
      }
    });

    function checkAddressFilled() {
      const addr = addressInput.value.trim();
      const pin = pincodeInput.value.trim();
      const city = cityInput.value.trim();
      const st = stateInput.value.trim();
      const phoneRes = validateAndNormalizePhone(phoneInput.value);

      if (addr.length >= 5 && pin.length === 6 && city.length >= 2 && st.length >= 2) {
        if (!state.eventsFired.address_filled) {
          state.eventsFired.address_filled = true;
          emitFunnelEvent('address_filled', {
            customerName: nameInput.value,
            customerPhone: phoneRes.isValid ? phoneRes.canonical : null,
            customerAddress: { street: addr, pincode: pin, city, state: st },
            pincode: pin,
            city,
            state: st,
            cartTotal: calculateTotal(),
          });
        }
      }
    }

    // 3. Mock OTP Handlers
    if (sendOtpBtn) {
      sendOtpBtn.addEventListener('click', async () => {
        const phoneRes = validateAndNormalizePhone(phoneInput.value);
        if (!phoneRes.isValid) {
          showAlert('Please enter a valid 10-digit mobile number first.', 'error');
          return;
        }

        sendOtpBtn.disabled = true;
        sendOtpBtn.textContent = 'Sending...';

        const res = await apiCall('/api/cod/otp/send', 'POST', {
          phone: phoneRes.canonical,
          sessionId,
          shopDomain: SHOP_DOMAIN,
        });

        sendOtpBtn.disabled = false;
        sendOtpBtn.textContent = 'Resend OTP';

        if (res.ok) {
          state.otpState.sent = true;
          document.getElementById('cod-otp-verify-row').style.display = 'flex';
          const hintEl = document.getElementById('cod-otp-hint');
          hintEl.style.display = 'block';
          hintEl.textContent = `⚡ Server logged OTP: ${res.data.debugCode} (or enter 000000)`;
          showAlert('OTP code sent to ' + phoneRes.canonical, 'success');
        } else {
          showAlert(res.data.error || 'Failed to send OTP', 'error');
        }
      });
    }

    if (verifyOtpBtn) {
      verifyOtpBtn.addEventListener('click', async () => {
        const code = otpInput.value.trim();
        const phoneRes = validateAndNormalizePhone(phoneInput.value);
        if (!code || code.length < 4) {
          showAlert('Please enter the OTP code.', 'error');
          return;
        }

        verifyOtpBtn.disabled = true;
        verifyOtpBtn.textContent = '...';

        const res = await apiCall('/api/cod/otp/verify', 'POST', {
          phone: phoneRes.canonical,
          code,
          sessionId,
          shopDomain: SHOP_DOMAIN,
        });

        verifyOtpBtn.disabled = false;
        verifyOtpBtn.textContent = 'Verify';

        if (res.ok) {
          state.otpState.verified = true;
          const box = document.getElementById('cod-otp-container');
          box.classList.add('verified');
          box.innerHTML = `<div style="color: #166534; font-weight: 600; font-size: 13.5px;">✓ Mobile Number Verified (+91 ${phoneRes.national10})</div>`;
          showAlert('Phone verified successfully!', 'success');
        } else {
          showAlert(res.data.error || 'Invalid OTP code', 'error');
        }
      });
    }

    // 4. Form Submit Handler -> Funnel Events: `submit_clicked` and `order_created`
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAlert();

      const name = nameInput.value.trim();
      const phoneRes = validateAndNormalizePhone(phoneInput.value);
      const addr = addressInput.value.trim();
      const pin = pincodeInput.value.trim();
      const city = cityInput.value.trim();
      const st = stateInput.value.trim();

      // Form validation
      if (!name) {
        showAlert('Please enter your full name.', 'error');
        nameInput.focus();
        return;
      }

      if (!phoneRes.isValid) {
        showAlert('Please enter a valid 10-digit Indian mobile number.', 'error');
        phoneInput.focus();
        return;
      }

      if (!addr || addr.length < 5) {
        showAlert('Please enter your full delivery address.', 'error');
        addressInput.focus();
        return;
      }

      if (!pin || pin.length !== 6) {
        showAlert('Please enter a valid 6-digit Pincode.', 'error');
        pincodeInput.focus();
        return;
      }

      // Check pincode blocklist
      if (state.settings.pincodeBlocklist && state.settings.pincodeBlocklist.includes(pin)) {
        showAlert(`Cash on Delivery is unavailable for Pincode ${pin}.`, 'error');
        return;
      }

      // Check OTP if required
      if (state.settings.requireOtp && !state.otpState.verified) {
        showAlert('Please complete Mobile OTP verification before submitting.', 'error');
        return;
      }

      const submitBtn = document.getElementById('cod-submit-order-btn');
      submitBtn.disabled = true;
      submitBtn.innerHTML = `<span>Placing your order... ⏳</span>`;

      // Funnel Event: submit_clicked
      emitFunnelEvent('submit_clicked', {
        idempotencyKey,
        customerName: name,
        customerPhone: phoneRes.canonical,
        cartTotal: calculateTotal(),
      });

      // Submit Order API with Idempotency Key
      const payload = {
        idempotencyKey,
        sessionId,
        shopDomain: SHOP_DOMAIN,
        customerName: name,
        customerPhone: phoneRes.canonical,
        shippingAddress: {
          address1: addr,
          pincode: pin,
          city,
          state: st,
        },
        productTitle: state.product.title,
        variantId: state.product.variantId,
        quantity: state.product.quantity || 1,
        unitPrice: state.product.price,
        codFee: state.settings.codFee || 0,
      };

      const res = await apiCall('/api/cod/order', 'POST', payload);

      if (res.ok && res.data.success) {
        state.eventsFired.order_created = true;
        showSuccessView(res.data, name, phoneRes.canonical);
      } else {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<span>Complete Cash on Delivery Order 📦</span>`;
        const errMsg = res.data.error || 'Failed to place COD order. Please try again.';
        showAlert(errMsg, 'error');
      }
    });
  }

  function calculateTotal() {
    const subtotal = (state.product.price || 0) * (state.product.quantity || 1);
    const fee = state.settings.codFee || 0;
    return subtotal + fee;
  }

  function updatePriceDisplay() {
    const itemPriceEl = document.getElementById('cod-summary-item-price');
    const feeEl = document.getElementById('cod-summary-fee');
    const totalEl = document.getElementById('cod-summary-total');
    const modalPriceEl = document.getElementById('cod-modal-prod-price');

    if (!itemPriceEl) return;

    const subtotal = (state.product.price || 0) * (state.product.quantity || 1);
    const fee = state.settings.codFee || 0;
    const total = subtotal + fee;

    itemPriceEl.textContent = `₹${subtotal.toFixed(2)}`;
    feeEl.textContent = fee > 0 ? `+ ₹${fee.toFixed(2)}` : 'FREE';
    totalEl.textContent = `₹${total.toFixed(2)}`;
    modalPriceEl.textContent = `₹${total.toFixed(2)}`;
  }

  function showAlert(msg, type = 'error') {
    const alertEl = document.getElementById('cod-global-alert');
    if (!alertEl) return;
    alertEl.textContent = msg;
    alertEl.className = 'cod-alert ' + type;
  }

  function clearAlert() {
    const alertEl = document.getElementById('cod-global-alert');
    if (!alertEl) return;
    alertEl.className = 'cod-alert';
    alertEl.textContent = '';
  }

  function showSuccessView(orderData, name, phone) {
    document.getElementById('cod-checkout-form').style.display = 'none';
    const successContainer = document.getElementById('cod-success-container');
    successContainer.style.display = 'block';

    document.getElementById('cod-confirmed-order-number').textContent = `Order ${orderData.orderNumber || '#1001'}`;
    document.getElementById('cod-confirmed-name').textContent = name;
    document.getElementById('cod-confirmed-phone').textContent = phone;
    document.getElementById('cod-confirmed-total').textContent = `₹${(orderData.totalPrice || calculateTotal()).toFixed(2)}`;
  }

  function openModal(productData = {}) {
    createModalDOM();
    state.product = Object.assign(state.product, productData);

    // Reset session for fresh open if previous was completed
    if (state.eventsFired.order_created) {
      sessionId = 'sess_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
      idempotencyKey = 'idem_' + sessionId + '_' + Date.now();
      state.eventsFired = {
        form_opened: false,
        phone_entered: false,
        address_filled: false,
        submit_clicked: false,
        order_created: false,
      };
      state.otpState = { sent: false, verified: false, code: '' };
      document.getElementById('cod-checkout-form').style.display = 'block';
      document.getElementById('cod-success-container').style.display = 'none';
      document.getElementById('cod-checkout-form').reset();
    }

    // Populate UI with product details
    document.getElementById('cod-modal-prod-title').textContent = state.product.title || 'Selected Product';
    document.getElementById('cod-modal-prod-qty').textContent = `Qty: ${state.product.quantity || 1}`;
    updatePriceDisplay();

    // Toggle OTP box visibility according to merchant settings
    const otpContainer = document.getElementById('cod-otp-container');
    if (otpContainer) {
      otpContainer.style.display = state.settings.requireOtp ? 'block' : 'none';
    }

    // Open overlay
    const overlay = document.getElementById('cod-modal-overlay');
    overlay.classList.add('active');

    // Funnel Event 1: `form_opened`
    if (!state.eventsFired.form_opened) {
      state.eventsFired.form_opened = true;
      emitFunnelEvent('form_opened', {
        productId: state.product.productId,
        productTitle: state.product.title,
        cartTotal: calculateTotal(),
        quantity: state.product.quantity || 1,
      });
    }
  }

  function closeModal() {
    const overlay = document.getElementById('cod-modal-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  // Auto-attach COD Button to Product Pages if placeholder exists
  function initAutoAttach() {
    loadSettings();
    createModalDOM();

    // Look for elements with data-cod-button
    document.querySelectorAll('[data-cod-trigger]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const prodTitle = btn.getAttribute('data-product-title') || document.title;
        const prodPrice = parseFloat(btn.getAttribute('data-product-price')) || 999;
        const prodQty = parseInt(btn.getAttribute('data-product-quantity'), 10) || 1;
        const variantId = btn.getAttribute('data-variant-id') || null;

        openModal({
          title: prodTitle,
          price: prodPrice,
          quantity: prodQty,
          variantId,
        });
      });
    });
  }

  // Expose global controller
  window.ShopifyCOD = {
    open: openModal,
    close: closeModal,
    loadSettings,
    validateAndNormalizePhone,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAutoAttach);
  } else {
    initAutoAttach();
  }
})();
