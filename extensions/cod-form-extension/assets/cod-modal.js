/**
 * COD Storefront Checkout Modal Controller
 * ─────────────────────────────────────────────────────────────
 * Theme-independent, mobile-first Cash on Delivery checkout modal.
 * Connects directly to Express backend API without third-party dependencies.
 */
(function () {
  'use strict';

  // Resolve API Base (Tunnel URL or Localhost)
  let API_BASE = window.COD_APP_API_BASE || '';
  if (!API_BASE || API_BASE.includes('default-app-home')) {
    API_BASE = window.location.origin.includes('localhost') ? window.location.origin : 'http://localhost:3000';
  }
  API_BASE = API_BASE.replace(/\/+$/, '');

  const SHOP_DOMAIN = (window.Shopify && window.Shopify.shop) || window.COD_SHOP_DOMAIN || 'daksh-cod-app.myshopify.com';
  const SHOP_NAME = window.COD_SHOP_NAME || 'Daksh COD';

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
      variantTitle: '',
      image: '',
      quantity: 1,
      id: null,
    },
    eventsFired: {
      form_opened: false,
      phone_entered: false,
      address_filled: false,
      submit_clicked: false,
      order_created: false,
    },
  };

  // Indian Phone Validator & Normalizer
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

  // Funnel Event Emitter
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
    try {
      const res = await apiCall(`/api/cod/settings?shop=${encodeURIComponent(SHOP_DOMAIN)}`);
      if (res.ok && res.data && res.data.settings) {
        state.settings = res.data.settings;
        updatePriceDisplay();
      }
    } catch (_) { }
  }

  // Currency Auto-Formatter
  function formatMoney(amount) {
    const num = parseFloat(amount) || 0;
    const isUSD = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active === 'USD') ||
      (document.body.innerText && document.body.innerText.includes('$') && !document.body.innerText.includes('₹'));
    const symbol = isUSD ? '$' : '₹';
    return symbol + num.toLocaleString(isUSD ? 'en-US' : 'en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function calculateTotal() {
    const subtotal = (state.product.price || 0) * (state.product.quantity || 1);
    const fee = state.settings.codFee || 0;
    return subtotal + fee;
  }

  // Update Dynamic Prices in Modal
  function updatePriceDisplay() {
    const qtyEl = document.getElementById('cod-modal-qty-val');
    const unitPriceEl = document.getElementById('cod-modal-unit-price');
    const subtotalEl = document.getElementById('cod-summary-subtotal');
    const feeEl = document.getElementById('cod-summary-cod-fee');
    const totalEl = document.getElementById('cod-summary-total-amt');
    const btnPriceEl = document.getElementById('cod-submit-btn-price');

    const qty = state.product.quantity || 1;
    const unitPrice = state.product.price || 0;
    const subtotal = unitPrice * qty;
    const fee = state.settings.codFee || 0;
    const total = subtotal + fee;

    if (qtyEl) qtyEl.textContent = qty;
    if (unitPriceEl) unitPriceEl.textContent = formatMoney(unitPrice);
    if (subtotalEl) subtotalEl.textContent = formatMoney(subtotal);
    if (feeEl) feeEl.textContent = fee > 0 ? `+ ${formatMoney(fee)}` : 'FREE';
    if (totalEl) totalEl.textContent = formatMoney(total);
    if (btnPriceEl) btnPriceEl.textContent = formatMoney(total);
  }

  // Build and Inject Modal DOM
  function createModalDOM() {
    if (document.getElementById('cod-modal-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'cod-modal-overlay';
    overlay.className = 'cod-modal-overlay';

    overlay.innerHTML = `
      <div class="cod-modal-card" role="dialog" aria-modal="true">
        <!-- 1. Header -->
        <div class="cod-modal-header">
          <div class="cod-header-brand">
            <div class="cod-header-logo-badge">
              <i class="bi bi-cash-stack"></i>
            </div>
            <div class="cod-header-title-box">
              <span class="cod-header-store-name" id="cod-header-store-name">Cash on Delivery</span>
              <span class="cod-header-secure-badge">
                <i class="bi bi-shield-check"></i> 100% Safe & Verified Order
              </span>
            </div>
          </div>
          <button type="button" class="cod-close-btn" id="cod-modal-close-btn" aria-label="Close">&times;</button>
        </div>

        <!-- 2. Scrollable Modal Body -->
        <div class="cod-modal-scroll-body">
          <div id="cod-global-alert" class="cod-global-alert"></div>

          <!-- Checkout Form View -->
          <div id="cod-form-container">
            <!-- Order Summary Card -->
            <div class="cod-summary-card">
              <div class="cod-product-row">
                <div id="cod-product-thumb-container">
                  <img src="" id="cod-product-img" class="cod-product-thumb" alt="Product" style="display:none;" />
                  <div id="cod-product-thumb-fallback" class="cod-product-thumb-placeholder">
                    <i class="bi bi-bag"></i>
                  </div>
                </div>

                <div class="cod-product-meta">
                  <div class="cod-product-name" id="cod-product-title">Selected Product</div>
                  <div class="cod-variant-badge" id="cod-product-variant" style="display:none;">Default</div>
                  <div class="cod-price-qty-row">
                    <span class="cod-unit-price" id="cod-modal-unit-price">₹0.00</span>
                    <div class="cod-qty-stepper">
                      <button type="button" class="cod-qty-btn" id="cod-qty-minus-btn" aria-label="Decrease quantity">-</button>
                      <span class="cod-qty-number" id="cod-modal-qty-val">1</span>
                      <button type="button" class="cod-qty-btn" id="cod-qty-plus-btn" aria-label="Increase quantity">+</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Payment Method Card -->
            <div class="cod-payment-method-box">
              <div class="cod-payment-method-left">
                <i class="bi bi-check-circle-fill cod-radio-icon"></i>
                <div class="cod-payment-method-text">
                  <span class="cod-payment-method-title">Cash on Delivery (COD)</span>
                  <span class="cod-payment-method-desc">Pay upon parcel arrival at your doorstep</span>
                </div>
              </div>
              <span class="cod-free-badge">PAY ON DELIVERY</span>
            </div>

            <!-- Customer Details Form -->
            <form id="cod-checkout-form" novalidate>
              <div class="cod-section-title">
                <i class="bi bi-geo-alt-fill"></i> Delivery Address
              </div>

              <div class="cod-form-grid">
                <!-- First & Last Name -->
                <div class="cod-input-row-2">
                  <div class="cod-input-group">
                    <label class="cod-input-label" for="cod-first-name">First Name <span class="req">*</span></label>
                    <div class="cod-input-wrapper">
                      <input type="text" id="cod-first-name" class="cod-text-input" placeholder="e.g. Rahul" required autocomplete="given-name" />
                    </div>
                    <div class="cod-field-error" id="cod-first-name-error">First name is required.</div>
                  </div>

                  <div class="cod-input-group">
                    <label class="cod-input-label" for="cod-last-name">Last Name <span class="req">*</span></label>
                    <div class="cod-input-wrapper">
                      <input type="text" id="cod-last-name" class="cod-text-input" placeholder="e.g. Sharma" required autocomplete="family-name" />
                    </div>
                    <div class="cod-field-error" id="cod-last-name-error">Last name is required.</div>
                  </div>
                </div>

                <!-- Phone Number -->
                <div class="cod-input-group">
                  <label class="cod-input-label" for="cod-phone">Mobile Number <span class="req">*</span></label>
                  <div class="cod-input-wrapper">
                    <input type="tel" id="cod-phone" class="cod-text-input" placeholder="10-digit mobile number" required autocomplete="tel" />
                    <span id="cod-phone-status-icon" class="cod-input-icon-right"></span>
                  </div>
                  <div class="cod-field-error" id="cod-phone-error">Please enter a valid 10-digit Indian mobile number.</div>
                </div>

                <!-- Email Address (Optional) -->
                <div class="cod-input-group">
                  <label class="cod-input-label" for="cod-email">Email Address <span style="font-size: 11px; font-weight: normal; color: #6b7280;">(Optional)</span></label>
                  <div class="cod-input-wrapper">
                    <input type="email" id="cod-email" class="cod-text-input" placeholder="e.g. name@example.com" autocomplete="email" />
                  </div>
                </div>

                <!-- Street Address -->
                <div class="cod-input-group">
                  <label class="cod-input-label" for="cod-address">House / Flat / Street / Area <span class="req">*</span></label>
                  <div class="cod-input-wrapper">
                    <input type="text" id="cod-address" class="cod-text-input" placeholder="House no, Building, Street, Landmark" required autocomplete="street-address" />
                  </div>
                  <div class="cod-field-error" id="cod-address-error">Please enter your complete street address.</div>
                </div>

                <!-- Pincode & City -->
                <div class="cod-input-row-2">
                  <div class="cod-input-group">
                    <label class="cod-input-label" for="cod-pincode">Pincode / ZIP <span class="req">*</span></label>
                    <div class="cod-input-wrapper">
                      <input type="text" id="cod-pincode" class="cod-text-input" placeholder="6-digit PIN" maxlength="6" required autocomplete="postal-code" />
                    </div>
                    <div class="cod-field-error" id="cod-pincode-error">Enter a valid 6-digit Pincode.</div>
                  </div>

                  <div class="cod-input-group">
                    <label class="cod-input-label" for="cod-city">City <span class="req">*</span></label>
                    <div class="cod-input-wrapper">
                      <input type="text" id="cod-city" class="cod-text-input" placeholder="e.g. Mumbai" required autocomplete="address-level2" />
                    </div>
                    <div class="cod-field-error" id="cod-city-error">City is required.</div>
                  </div>
                </div>

                <!-- State -->
                <div class="cod-input-group">
                  <label class="cod-input-label" for="cod-state">State <span class="req">*</span></label>
                  <div class="cod-input-wrapper">
                    <input type="text" id="cod-state" class="cod-text-input" placeholder="e.g. Maharashtra" required autocomplete="address-level1" />
                  </div>
                  <div class="cod-field-error" id="cod-state-error">State is required.</div>
                </div>
              </div>

              <!-- Price Breakdown -->
              <div class="cod-breakdown-box">
                <div class="cod-breakdown-row">
                  <span>Product Subtotal:</span>
                  <span id="cod-summary-subtotal">₹0.00</span>
                </div>
                <div class="cod-breakdown-row">
                  <span>Shipping:</span>
                  <span style="color: #108043; font-weight: 700;">FREE</span>
                </div>
                <div class="cod-breakdown-row">
                  <span>COD Handling Fee:</span>
                  <span id="cod-summary-cod-fee">FREE</span>
                </div>
                <div class="cod-breakdown-row total-row">
                  <span>Total Amount Due on Delivery:</span>
                  <span class="total-amt" id="cod-summary-total-amt">₹0.00</span>
                </div>
              </div>

              <!-- Submit Button -->
              <button type="submit" id="cod-submit-order-btn" class="cod-submit-order-btn">
                <i class="bi bi-lightning-charge-fill" style="color: #fbbf24;"></i>
                <span>Complete Cash on Delivery Order • <span id="cod-submit-btn-price">₹0.00</span></span>
              </button>

              <!-- Trust Badges -->
              <div class="cod-trust-badges-row">
                <div class="cod-trust-item"><i class="bi bi-shield-lock-fill"></i> Safe & Secure</div>
                <div class="cod-trust-item"><i class="bi bi-cash-stack"></i> Pay on Delivery</div>
                <div class="cod-trust-item"><i class="bi bi-truck"></i> Fast Dispatch</div>
              </div>
            </form>
          </div>

          <!-- Success View -->
          <div id="cod-success-container" class="cod-success-card" style="display: none;">
            <div class="cod-success-icon-wrap">
              <i class="bi bi-check-lg"></i>
            </div>
            <h3 class="cod-success-title">Order Confirmed!</h3>
            <p class="cod-success-subtitle">Your Cash on Delivery order is placed and being prepared for dispatch.</p>
            <div class="cod-order-pill" id="cod-confirmed-order-number">Order #1001</div>

            <div class="cod-order-receipt">
              <div><strong>Deliver to:</strong> <span id="cod-confirmed-name"></span></div>
              <div style="margin-top: 4px;"><strong>Contact:</strong> <span id="cod-confirmed-phone"></span></div>
              <div style="margin-top: 4px;"><strong>Payment on Delivery:</strong> <span id="cod-confirmed-total" style="color: #108043; font-weight: 800;"></span></div>
            </div>

            <button type="button" class="cod-close-success-btn" id="cod-success-close-btn">
              Continue Shopping
            </button>
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
    const closeBtn = document.getElementById('cod-modal-close-btn');
    const successCloseBtn = document.getElementById('cod-success-close-btn');
    const form = document.getElementById('cod-checkout-form');

    const firstNameInput = document.getElementById('cod-first-name');
    const lastNameInput = document.getElementById('cod-last-name');
    const phoneInput = document.getElementById('cod-phone');
    const addressInput = document.getElementById('cod-address');
    const pincodeInput = document.getElementById('cod-pincode');
    const cityInput = document.getElementById('cod-city');
    const stateInput = document.getElementById('cod-state');

    const minusBtn = document.getElementById('cod-qty-minus-btn');
    const plusBtn = document.getElementById('cod-qty-plus-btn');

    // Close Handlers
    closeBtn.addEventListener('click', closeModal);
    if (successCloseBtn) successCloseBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    // Quantity Stepper Handlers inside Modal
    if (minusBtn && plusBtn) {
      minusBtn.addEventListener('click', () => {
        if (state.product.quantity > 1) {
          state.product.quantity--;
          updatePriceDisplay();
        }
      });
      plusBtn.addEventListener('click', () => {
        state.product.quantity++;
        updatePriceDisplay();
      });
    }

    // Phone Validation & `phone_entered` Funnel Event
    let phoneTimer;
    phoneInput.addEventListener('input', () => {
      clearTimeout(phoneTimer);
      phoneTimer = setTimeout(() => handlePhoneCheck(phoneInput.value), 400);
    });
    phoneInput.addEventListener('blur', () => handlePhoneCheck(phoneInput.value));

    function handlePhoneCheck(val) {
      const iconEl = document.getElementById('cod-phone-status-icon');
      const errEl = document.getElementById('cod-phone-error');
      const res = validateAndNormalizePhone(val);

      if (res.isValid) {
        phoneInput.classList.remove('invalid');
        errEl.style.display = 'none';
        iconEl.innerHTML = `<i class="bi bi-check-circle-fill" style="color: #108043;"></i>`;

        if (!state.eventsFired.phone_entered) {
          state.eventsFired.phone_entered = true;
          const fullName = [firstNameInput.value.trim(), lastNameInput.value.trim()].filter(Boolean).join(' ');
          emitFunnelEvent('phone_entered', {
            customerName: fullName,
            customerPhone: res.canonical,
            cartTotal: calculateTotal(),
          });
        }
      } else if (val.trim().length > 0) {
        phoneInput.classList.add('invalid');
        errEl.style.display = 'block';
        iconEl.innerHTML = `<i class="bi bi-exclamation-circle-fill" style="color: #ef4444;"></i>`;
      } else {
        phoneInput.classList.remove('invalid');
        errEl.style.display = 'none';
        iconEl.innerHTML = '';
      }
    }

    // Address & Pincode Completion -> `address_filled` Funnel Event
    const addrFields = [addressInput, pincodeInput, cityInput, stateInput];
    addrFields.forEach((f) => f.addEventListener('blur', checkAddressFilled));

    pincodeInput.addEventListener('input', () => {
      const pin = pincodeInput.value.trim();
      const pinErrorEl = document.getElementById('cod-pincode-error');
      if (state.settings.pincodeBlocklist && state.settings.pincodeBlocklist.includes(pin)) {
        pincodeInput.classList.add('invalid');
        pinErrorEl.textContent = `❌ COD is unavailable for pincode ${pin}.`;
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
      const fullName = [firstNameInput.value.trim(), lastNameInput.value.trim()].filter(Boolean).join(' ');

      if (addr.length >= 5 && pin.length === 6 && city.length >= 2 && st.length >= 2) {
        if (!state.eventsFired.address_filled) {
          state.eventsFired.address_filled = true;
          emitFunnelEvent('address_filled', {
            customerName: fullName,
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

    // Form Submission
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAlert();

      const fName = firstNameInput.value.trim();
      const lName = lastNameInput.value.trim();
      const phoneRes = validateAndNormalizePhone(phoneInput.value);
      const addr = addressInput.value.trim();
      const pin = pincodeInput.value.trim();
      const city = cityInput.value.trim();
      const st = stateInput.value.trim();

      // Field Validations
      let hasError = false;

      if (!fName) {
        firstNameInput.classList.add('invalid');
        hasError = true;
      } else {
        firstNameInput.classList.remove('invalid');
      }

      if (!lName) {
        lastNameInput.classList.add('invalid');
        hasError = true;
      } else {
        lastNameInput.classList.remove('invalid');
      }

      if (!phoneRes.isValid) {
        phoneInput.classList.add('invalid');
        document.getElementById('cod-phone-error').style.display = 'block';
        hasError = true;
      } else {
        phoneInput.classList.remove('invalid');
      }

      if (!addr || addr.length < 5) {
        addressInput.classList.add('invalid');
        hasError = true;
      } else {
        addressInput.classList.remove('invalid');
      }

      if (!pin || pin.length !== 6) {
        pincodeInput.classList.add('invalid');
        document.getElementById('cod-pincode-error').textContent = 'Enter a valid 6-digit Pincode.';
        document.getElementById('cod-pincode-error').style.display = 'block';
        hasError = true;
      } else {
        pincodeInput.classList.remove('invalid');
      }

      if (!city) {
        cityInput.classList.add('invalid');
        hasError = true;
      } else {
        cityInput.classList.remove('invalid');
      }

      if (!st) {
        stateInput.classList.add('invalid');
        hasError = true;
      } else {
        stateInput.classList.remove('invalid');
      }

      if (hasError) {
        showAlert('Please fill in all required delivery fields.', 'error');
        return;
      }

      if (state.settings.pincodeBlocklist && state.settings.pincodeBlocklist.includes(pin)) {
        showAlert(`Cash on Delivery is unavailable for Pincode ${pin}.`, 'error');
        return;
      }

      const fullName = `${fName} ${lName}`.trim();
      const emailInput = document.getElementById('cod-email');
      const emailVal = emailInput ? emailInput.value.trim() : '';
      const submitBtn = document.getElementById('cod-submit-order-btn');
      submitBtn.disabled = true;
      submitBtn.innerHTML = `<i class="bi bi-arrow-repeat cod-spinner"></i> <span>Placing your order...</span>`;

      // Funnel Event: submit_clicked
      emitFunnelEvent('submit_clicked', {
        idempotencyKey,
        customerName: fullName,
        customerPhone: phoneRes.canonical,
        customerEmail: emailVal,
        cartTotal: calculateTotal(),
      });

      // Submit Order API Payload
      const payload = {
        idempotencyKey,
        sessionId,
        shopDomain: SHOP_DOMAIN,
        customerName: fullName,
        customerPhone: phoneRes.canonical,
        customerEmail: emailVal,
        shippingAddress: {
          address1: addr,
          pincode: pin,
          city: city,
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
        showSuccessView(res.data, fullName, phoneRes.canonical);
      } else {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
          <i class="bi bi-lightning-charge-fill" style="color: #fbbf24;"></i>
          <span>Complete Cash on Delivery Order • <span id="cod-submit-btn-price">${formatMoney(calculateTotal())}</span></span>
        `;
        const errMsg = (res.data && res.data.error) || 'Failed to place COD order. Please try again.';
        showAlert(errMsg, 'error');
      }
    });
  }

  function showAlert(msg, type = 'error') {
    const alertEl = document.getElementById('cod-global-alert');
    if (!alertEl) return;
    alertEl.textContent = msg;
    alertEl.className = 'cod-global-alert ' + type;
  }

  function clearAlert() {
    const alertEl = document.getElementById('cod-global-alert');
    if (!alertEl) return;
    alertEl.className = 'cod-global-alert';
    alertEl.textContent = '';
  }

  function showSuccessView(orderData, name, phone) {
    document.getElementById('cod-form-container').style.display = 'none';
    const successContainer = document.getElementById('cod-success-container');
    successContainer.style.display = 'block';

    document.getElementById('cod-confirmed-order-number').textContent = `Order ${orderData.orderNumber || '#1001'}`;
    document.getElementById('cod-confirmed-name').textContent = name;
    document.getElementById('cod-confirmed-phone').textContent = phone;
    document.getElementById('cod-confirmed-total').textContent = formatMoney(orderData.totalPrice || calculateTotal());
  }

  function openModal(productData = {}) {
    createModalDOM();
    state.product = Object.assign(state.product, productData);

    // Reset Session if previous order was completed
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
      document.getElementById('cod-form-container').style.display = 'block';
      document.getElementById('cod-success-container').style.display = 'none';
      document.getElementById('cod-checkout-form').reset();
    }

    // Populate Product Card
    const titleEl = document.getElementById('cod-product-title');
    const variantEl = document.getElementById('cod-product-variant');
    const imgEl = document.getElementById('cod-product-img');
    const fallbackImgEl = document.getElementById('cod-product-thumb-fallback');

    if (titleEl) titleEl.textContent = state.product.title || 'Selected Product';
    if (variantEl) {
      if (state.product.variantTitle && state.product.variantTitle !== 'Default Title') {
        variantEl.textContent = state.product.variantTitle;
        variantEl.style.display = 'inline-block';
      } else {
        variantEl.style.display = 'none';
      }
    }

    if (imgEl && state.product.image) {
      imgEl.src = state.product.image;
      imgEl.style.display = 'block';
      if (fallbackImgEl) fallbackImgEl.style.display = 'none';
    } else if (fallbackImgEl) {
      fallbackImgEl.style.display = 'flex';
      if (imgEl) imgEl.style.display = 'none';
    }

    updatePriceDisplay();

    // Show Modal
    const overlay = document.getElementById('cod-modal-overlay');
    overlay.classList.add('active');

    // Funnel Event: form_opened
    if (!state.eventsFired.form_opened) {
      state.eventsFired.form_opened = true;
      emitFunnelEvent('form_opened', {
        productId: state.product.productId || state.product.id,
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

  // ── Live DOM Readers (theme-independent) ──────────────────────
  function readLiveQuantity(fallback) {
    const selectors = [
      'input[name="quantity"]',
      '[data-quantity-input]',
      '.quantity__input',
      '.qty-input',
      '#quantity',
      'input.quantity',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const val = parseInt(el.value, 10);
        if (val > 0) return val;
      }
    }
    return fallback || 1;
  }

  function readLiveVariantId(fallback) {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const urlVariant = urlParams.get('variant');
      if (urlVariant && /^\d+$/.test(urlVariant)) return urlVariant;
    } catch (_) { }

    const el = document.querySelector(
      'form[action*="/cart/add"] input[name="id"], input[name="id"]:checked, select[name="id"], input[name="id"]'
    );
    return (el && el.value) ? el.value : fallback;
  }

  function readLiveVariantTitle(fallback) {
    try {
      const select = document.querySelector('form[action*="/cart/add"] select[name="id"], select[name="id"]');
      if (select && select.selectedOptions && select.selectedOptions[0]) {
        const txt = select.selectedOptions[0].textContent.trim();
        if (txt && !txt.startsWith('$') && !txt.startsWith('₹')) return txt;
      }
      const checkedLabels = Array.from(document.querySelectorAll('fieldset input:checked + label, .variant-picker input:checked + label, [data-variant-picker] input:checked + label'))
        .map((l) => l.textContent.trim())
        .filter(Boolean);
      if (checkedLabels.length > 0) return checkedLabels.join(' / ');
    } catch (_) { }
    return fallback;
  }

  function readLivePrice(fallback) {
    const selectors = [
      '[data-product-price]',
      '.price__regular .price-item--regular',
      '.price-item--regular',
      '.price .price-item--sale',
      '.product__price .money',
      '.price .money',
      '.product-single__price',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const val = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
        if (!isNaN(val) && val > 0) return val;
      }
    }
    return fallback;
  }

  // Initialize and Attach Trigger Listeners
  function initAutoAttach() {
    loadSettings();
    createModalDOM();

    // 1. Direct attachment to existing buttons
    function attachDirect() {
      document.querySelectorAll('[data-cod-trigger], [data-cod-trigger-embed], .cod-trigger-btn').forEach((btn) => {
        if (btn.__codAttached) return;
        btn.__codAttached = true;

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          triggerModalFromButton(btn);
        });
      });
    }

    attachDirect();

    // 2. Global Delegated Click Listener (catches dynamic theme re-renders / Dawn section updates)
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-cod-trigger], [data-cod-trigger-embed], .cod-trigger-btn, #cod-app-buy-now-btn');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        triggerModalFromButton(btn);
      }
    }, true);
  }

  function triggerModalFromButton(btn) {
    const prodTitle = btn.getAttribute('data-product-title') || (window.COD_PRODUCT && window.COD_PRODUCT.title) || document.title;
    const staticPrice = parseFloat(btn.getAttribute('data-product-price')) || (window.COD_PRODUCT && window.COD_PRODUCT.price) || 0;
    const staticQty = parseInt(btn.getAttribute('data-product-quantity'), 10) || 1;
    const staticVid = btn.getAttribute('data-variant-id') || (window.COD_PRODUCT && window.COD_PRODUCT.variantId) || null;
    const staticVTitle = btn.getAttribute('data-variant-title') || (window.COD_PRODUCT && window.COD_PRODUCT.variantTitle) || '';
    const prodImg = btn.getAttribute('data-product-image') || (window.COD_PRODUCT && window.COD_PRODUCT.image) || '';
    const prodId = btn.getAttribute('data-product-id') || (window.COD_PRODUCT && window.COD_PRODUCT.id) || null;

    const prodPrice = readLivePrice(staticPrice);
    const prodQty = readLiveQuantity(staticQty);
    const variantId = readLiveVariantId(staticVid);
    const variantTitle = readLiveVariantTitle(staticVTitle);

    openModal({
      title: prodTitle,
      price: prodPrice,
      quantity: prodQty,
      variantId,
      variantTitle,
      image: prodImg,
      productId: prodId,
    });
  }

  // Expose Global Controller
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
