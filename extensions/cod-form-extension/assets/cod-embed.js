/**
 * cod-embed.js — COD App Embed Auto-Inject Script
 * ─────────────────────────────────────────────────
 * Loaded by cod_embed.liquid (target: body App Embed block).
 * Auto-detects product pages across all Shopify themes.
 */
(function () {
  'use strict';

  function isProductPage() {
    if (window.COD_PRODUCT) return true;
    var meta = window.ShopifyAnalytics && window.ShopifyAnalytics.meta;
    if (meta && meta.product) return true;
    return /\/products\/[^/?#]+/.test(window.location.pathname);
  }

  function getProductData() {
    if (window.COD_PRODUCT) return window.COD_PRODUCT;

    var meta = window.ShopifyAnalytics &&
               window.ShopifyAnalytics.meta &&
               window.ShopifyAnalytics.meta.product;
    if (meta) {
      var v = meta.variants && meta.variants[0];
      return {
        title:        meta.title || document.title,
        id:           meta.id,
        variantId:    v && v.id,
        variantTitle: v && v.title,
        price:        v ? v.price / 100 : 0,
        image:        ''
      };
    }
    return null;
  }

  function getLiveQuantity(fallback) {
    var selectors = [
      'input[name="quantity"]',
      '[data-quantity-input]',
      '.quantity__input',
      '.qty-input',
      '#quantity',
      'input.quantity',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) {
        var val = parseInt(el.value, 10);
        if (val > 0) return val;
      }
    }
    return fallback || 1;
  }

  function getLiveVariantId(fallback) {
    try {
      var urlParams = new URLSearchParams(window.location.search);
      var urlVariant = urlParams.get('variant');
      if (urlVariant && /^\d+$/.test(urlVariant)) return urlVariant;
    } catch (_) {}

    var el = document.querySelector('form[action*="/cart/add"] input[name="id"], input[name="id"]:checked, select[name="id"], input[name="id"]');
    if (el && el.value) return el.value;
    return fallback;
  }

  function getLivePrice(fallback) {
    var selectors = [
      '[data-product-price]',
      '.price__regular .price-item--regular',
      '.price-item--regular',
      '.product__price .money',
      '.price .money',
      '.product-single__price',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) {
        var raw = el.textContent.replace(/[^0-9.]/g, '');
        var val = parseFloat(raw);
        if (!isNaN(val) && val > 0) return val;
      }
    }
    return fallback;
  }

  function buildCodButton(settings) {
    var label = (settings && settings.buttonLabel) || 'Buy with COD';
    var bg    = (settings && settings.btnColor)    || '#108043';
    var color = (settings && settings.btnTextColor) || '#ffffff';

    var wrapper = document.createElement('div');
    wrapper.id = 'cod-embed-wrapper';
    wrapper.className = 'cod-button-wrapper';
    wrapper.style.marginTop = '12px';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'cod-embed-trigger-btn';
    btn.className = 'cod-trigger-btn';
    btn.setAttribute('data-cod-trigger-embed', '');
    btn.style.background = bg;
    btn.style.color = color;
    btn.innerHTML =
      '<i class="bi bi-cash-coin" style="margin-right: 6px;"></i>' +
      '<span>' + label + '</span>';

    wrapper.appendChild(btn);
    return { wrapper: wrapper, btn: btn };
  }

  var INJECT_AFTER_SELECTORS = [
    '.shopify-payment-button',
    '.product-form__payment-container',
    '.product__payment-button-wrapper',
    'form[action="/cart/add"]',
    '.product-form',
    '.product__form',
    'button[name="add"]',
    '[data-add-to-cart]',
    'button[type="submit"].product-form__submit',
    'button[type="submit"].btn--add-to-cart',
    '.product__submit button[type="submit"]',
  ];

  var CART_INJECT_SELECTORS = [
    'button[name="checkout"]',
    '.cart__checkout-button',
    '.cart-drawer__footer button[type="submit"]',
    '.cart__footer button[type="submit"]',
    '#cart-drawer .cart-drawer__footer',
    '.cart__footer',
    'a[href="/checkout"]',
    'form[action="/cart"] [type="submit"]',
  ];

  function findCartInsertionPoint() {
    for (var i = 0; i < CART_INJECT_SELECTORS.length; i++) {
      var el = document.querySelector(CART_INJECT_SELECTORS[i]);
      if (el && el.offsetParent !== null) return el;
    }
    for (var j = 0; j < CART_INJECT_SELECTORS.length; j++) {
      var elAny = document.querySelector(CART_INJECT_SELECTORS[j]);
      if (elAny) return elAny;
    }
    return null;
  }

  function injectCartButton(settings) {
    if (document.getElementById('cod-cart-embed-wrapper')) return;

    var anchor = findCartInsertionPoint();
    if (!anchor) return;

    var label = (settings && settings.buttonLabel) || 'Order with Cash on Delivery (COD)';
    var bg    = (settings && settings.btnColor)    || '#108043';
    var color = (settings && settings.btnTextColor) || '#ffffff';

    var wrapper = document.createElement('div');
    wrapper.id = 'cod-cart-embed-wrapper';
    wrapper.className = 'cod-button-wrapper cod-cart-button-wrapper';
    wrapper.style.margin = '10px 0';
    wrapper.style.width = '100%';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'cod-cart-trigger-btn';
    btn.className = 'cod-trigger-btn';
    btn.setAttribute('data-cod-cart-trigger', '');
    btn.style.width = '100%';
    btn.style.padding = '14px 20px';
    btn.style.fontSize = '15px';
    btn.style.fontWeight = '700';
    btn.style.background = bg;
    btn.style.color = color;
    btn.style.borderRadius = '10px';
    btn.style.border = 'none';
    btn.style.cursor = 'pointer';
    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.gap = '8px';
    btn.innerHTML =
      '<i class="bi bi-cash-coin" style="font-size: 18px;"></i>' +
      '<span>' + label + '</span>';

    wrapper.appendChild(btn);

    var parent = anchor.parentNode;
    parent.insertBefore(wrapper, anchor);

    btn.addEventListener('click', async function (e) {
      e.preventDefault();
      e.stopPropagation();

      try {
        var cartRes = await fetch('/cart.js');
        var cart = await cartRes.json();

        if (!cart || !cart.items || cart.items.length === 0) {
          alert('Your cart is empty.');
          return;
        }

        var firstItem = cart.items[0];
        var itemNames = cart.items.map(function(it) { return it.quantity + 'x ' + it.title; }).join(', ');

        if (window.ShopifyCOD && typeof window.ShopifyCOD.open === 'function') {
          window.ShopifyCOD.open({
            title:        cart.items.length === 1 ? firstItem.title : (cart.item_count + ' items: ' + firstItem.title),
            price:        cart.total_price / 100,
            quantity:     1,
            variantId:    firstItem.variant_id,
            variantTitle: firstItem.variant_title || '',
            image:        firstItem.image || '',
            productId:    firstItem.product_id,
          });
        }
      } catch (err) {
        console.error('[COD Cart Error]:', err);
      }
    });
  }

  function init() {
    var settings = window.COD_EMBED_SETTINGS || {};

    if (isProductPage()) {
      var product = getProductData();
      if (product) {
        var attempts = 0;
        var timer = setInterval(function () {
          attempts++;
          if (document.getElementById('cod-embed-wrapper')) {
            clearInterval(timer);
            return;
          }
          var anchor = findInsertionPoint();
          if (anchor || attempts >= 10) {
            clearInterval(timer);
            injectButton(product, settings);
          }
        }, 300);
      }
    }

    // Continuously check for Cart Drawer or Cart Page
    setInterval(function () {
      injectCartButton(settings);
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
