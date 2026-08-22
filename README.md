# Shopify Cash-On-Delivery (COD) Order Form Engine

> A high-reliability, one-click Cash-on-Delivery (COD) checkout app for Shopify with truthful session-based funnel tracking, strict idempotency protection, abuse prevention, and merchant recovery tools.

---

## 1. Architecture in 10 Lines

```
[Storefront Product Page] 
    │ (1-Click "⚡ Cash on Delivery" Trigger)
    ▼
[Storefront COD Modal / Theme Extension Block]
    │ ─── Step Events (form_opened, phone_entered, address_filled, submit_clicked) ───► [Funnel Tracker]
    │ ─── SMS OTP Verification (Mock) ───► [OTP Verification Service]
    │ ─── Submit Order + Idempotency Key ───► [Idempotency & Concurrency Guard]
    ▼                                                  │
[Express API & Drizzle ORM (SQLite / WAL)]             ▼
    │ (Server-side Shop Resolution)          [Shopify Admin API] (orderCreate / Draft Orders)
    ▼                                                  │
[Merchant Dashboard (Polaris UI)]                      ▼
  • Funnel Analytics & Biggest Drop Alerts   [Real Shopify Store Orders (Tagged COD-Form)]
  • Abandoned Leads + WhatsApp 1-Click Recovery
  • Live Merchant Settings (COD Fee, Pincode Blocklist, OTP Toggle)
```

---

## 2. Setup Steps

### Prerequisites
- Node.js `v18+` (tested on Node `v24`)
- npm `v9+`

### Quick Start (Local Run in Sandbox / Simulator Mode)
1. **Clone the repository:**
   ```bash
   git clone <repo-url>
   cd Shopify-assign
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Start the application:**
   ```bash
   npm start
   ```
4. **Open in your browser:**
   - 🛍️ **Storefront Product Page Demo:** [http://localhost:3000/demo](http://localhost:3000/demo)
   - 📊 **Merchant Funnel Dashboard:** [http://localhost:3000/dashboard](http://localhost:3000/dashboard)

### Connecting to Live Shopify Development Store (`daksh-cod-app.myshopify.com`)
1. Create a `.env` file from `.env.example`:
   ```bash
   cp .env.example .env
   ```
2. Populate the Shopify Admin Access Token:
   ```env
   PORT=3000
   SHOPIFY_SHOP_DOMAIN=daksh-cod-app.myshopify.com
   SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxx
   SHOPIFY_API_VERSION=2024-04
   ```
3. Run with Cloudflare tunnel / ngrok for storefront proxying:
   ```bash
   npx cloudflared tunnel --url http://localhost:3000
   ```

### Running Automated Test Suite
Run the end-to-end verification test suite:
```bash
npm test
```
Tests phone normalization (+91 canonical formats), funnel deduplication, idempotency race conditions, mock OTP generation/verification, and abandoned lead extraction.

---

---

## 🧠 WHAT WE'RE WATCHING FOR: The Honest Edge Cases & Funnel Truthfulness

> *"If your funnel numbers can't be trusted, the feature is decoration."*

In e-commerce analytics, client-side pixel tracking and naive counters frequently deceive merchants. Below is exactly how our architecture handles the three fundamental edge cases to ensure **100% truthful, mathematical integrity** across every metric:

```
+-----------------------------------------------------------------------------------------+
|                                 FUNNEL TRUTHFULNESS MATRIX                              |
+------------------------------------+--------------------------+-------------------------+
| Edge Case Scenario                 | Naive Tracker (Broken)   | Our Engine (Truthful)   |
+------------------------------------+--------------------------+-------------------------+
| Customer opens modal 3 times       | 3 sessions (+200% bloat) | Exactly 1 session       |
| Submit fails -> User retries       | 2 submits / 1 order (50%)| 1 submit / 1 order(100%)|
| Network drops before thank-you UI  | 0 orders in analytics    | 1 confirmed order       |
+------------------------------------+--------------------------+-------------------------+
```

---

### 1. Edge Case: Customer opens the form 3 times but orders once

* **The Failure Mode:** A shopper on mobile clicks "Buy with COD", closes the popup to re-check product specifications, re-opens the popup, selects a different color/quantity, closes it again, and finally re-opens it to complete the purchase. Naive analytics record 3 `form_opened` events, inflating top-of-funnel traffic by 300% and falsely making the checkout look broken.
* **How We Keep It Truthful:**
  1. **Session Stitching (`sessionStorage`):** The storefront client binds all interactions to an immutable `sessionId` (`sess_<random>_<timestamp>`) stored in browser session memory.
  2. **Client In-Memory Milestone Guards:** The client maintains an in-memory guard dictionary (`eventsFired.form_opened = true`). Subsequent modal re-opens in the same tab suppress duplicate network calls.
  3. **SQL Set-Theoretic Deduplication:** Even if client state resets (e.g. page refresh), the server funnel query aggregates by distinct sessions:
     ```sql
     SELECT COUNT(DISTINCT session_id) AS step_count
     FROM funnel_events
     WHERE event_name = 'form_opened' AND shop_domain = ?
     ```
  4. **The Guarantee:** 3 modal opens in 1 shopping journey = **Exactly 1 Top-of-Funnel Session**.

---

### 2. Edge Case: A submit that fails, then succeeds on retry

* **The Failure Mode:** A shopper fills the form but mistypes a blocked PIN code or experiences a transient mobile network dropout during submit. The UI shows an error. The customer corrects their PIN and clicks "Complete Order" again. A naive tracker records 2 `submit_clicked` events and 1 `order_created`, falsely showing a **50% drop-off** at the finish line when the customer actually converted at 100%.
* **How We Keep It Truthful:**
  1. **Distinct Submission Intent:** The `submit_clicked` funnel count is calculated using `COUNT(DISTINCT session_id)`. Multiple retry clicks in the same session represent one continuous buying intent and are counted as **1 unique submission**.
  2. **State Machine Recovery (`FAILED` $\rightarrow$ `PROCESSING` $\rightarrow$ `SUCCESS`):**
     - When the first attempt fails validation (e.g. Pincode Blocklist or Shopify 503), the server records the error without incrementing the order count.
     - Upon retry with corrected data, the backend locks the state back to `PROCESSING` and dispatches to Shopify.
  3. **The Guarantee:** 1 failed click + 1 successful retry = **1 Submit $\rightarrow$ 1 Order (100% Step Conversion Rate)**.

---

### 3. Edge Case: An `order_created` event racing the thank-you screen

* **The Failure Mode:** The server contacts Shopify Admin API, successfully creates order `#1001`, and commits the database record. But before the HTTP response reaches the browser (due to poor mobile signal or impatient user clicking reload/back), the connection drops. If tracking depends on the client-side thank-you screen loading to fire a "pixel", the order is placed on Shopify but missing from analytics! Conversely, if the customer double-taps out of frustration, a naive system creates **two duplicate Shopify orders**.
* **How We Keep It Truthful:**
  1. **Server-Side Single Source of Truth:** The `order_created` funnel milestone is emitted **server-side inside the atomic order commit transaction** (`src/services/idempotency.js`). It does NOT depend on client-side pixels or thank-you page execution.
  2. **Deterministic Idempotency Key:** Every checkout attempt carries a deterministic `idempotency_key`. The `orders` SQLite table enforces a `UNIQUE(idempotency_key)` constraint.
  3. **0ms Cached Replay (`DUPLICATE_CACHE_HIT`):** If the customer reloads or double-clicks, the server intercepts the duplicate key:
     - Sees `status = 'SUCCESS'`.
     - Skips calling Shopify Admin API entirely (0ms external latency).
     - Returns the cached `#1001` order confirmation immediately.
     - Logs a `DUPLICATE_CACHE_HIT` trace in the Idempotency Waterfall.
  4. **The Guarantee:** The order is always created **exactly once on Shopify**, and the merchant dashboard always reflects the **real Shopify order count ($COUNT(\text{Orders}) \equiv COUNT(\text{Order Created Events})$)**.

---

## 4. Idempotency Waterfall Architecture

Below is the exact stage-by-stage lifecycle recorded in the SQLite database and rendered live in the Merchant Dashboard:

```
[Storefront Request: POST /api/cod/order]
              |
              v
     1. REQUEST_INGRESS (Extract idempotencyKey: idem_sess_...)
              |
              v
     2. LOCK_LOOKUP (Check SQLite orders table for existing key)
             / \
            /   \
  [Key Exists & SUCCESS]   [Key is New]
          /               \
         v                 v
 3a. DUPLICATE_CACHE_HIT  3b. ATOMIC_LOCK_ACQUIRED (Insert status: 'PROCESSING')
 (Return cached order,     |
  0ms Shopify API call)    v
                          4. SHOPIFY_DISPATCH (POST /admin/api/2024-04/orders.json with 10s Timeout Guard)
                           |
                           v
                          5. SHOPIFY_CONFIRMED (HTTP 201 Created -> Order #1001)
                           |
                           v
                          6. DB_COMMITTED_SUCCESS (Atomic update status: 'SUCCESS')
```

---

## 5. Failure Modes Handled

| Failure Scenario | How the App Handles It | Customer & Merchant Experience |
|---|---|---|
| **Customer double-clicks "Submit"** | Idempotency lock catches in-flight key; subsequent call returns the original order. | Exactly 1 Shopify order created; customer sees instant thank-you screen. |
| **Invalid Indian Phone Number** | Real-time normalization rejects invalid formats, non-mobile digits, or invalid prefixes (must start with 6/7/8/9). | Red inline error; `phone_entered` event is suppressed until valid. |
| **Pincode Blocklist** | Frontend checks merchant blocked list live; backend double-checks before creating order. | Inline message: *"Cash on Delivery is unavailable for PIN code XXXXXX"*. |
| **Shopify API Timeout (>10s)** | `AbortController` terminates request after 10s; records `status: 'TIMED_OUT'`. | Customer gets clear alert with recovery advice instead of an infinite spinner. |
| **Spam / Abuse Attempts** | IP-level rate limiter (`express-rate-limit`) + in-memory phone submit throttler. | Returns HTTP 429 *"Too many order attempts"*; merchant protected from fake COD bots. |
| **Customer Abandons at Address** | Lead captured at Step 2 (`customer_phone` saved in session). | Appears in **Abandoned Leads Recovery Hub** with a 1-click WhatsApp recovery link. |
| **Payment Webhook Forgery** | Verifies `X-Shopify-Hmac-Sha256` using constant-time comparison (`crypto.timingSafeEqual`). | Forged webhooks rejected with 401 Unauthorized; valid payments update order to `PAID`. |

---

## 6. Merchant Settings Impact on Storefront

Merchants can configure live rules from the Dashboard (`/dashboard`):
1. **COD Handling Fee (INR)**: Adds an extra convenience fee (e.g. ₹49.00) calculated live in the modal price breakdown and added as a custom Shopify shipping line.
2. **Pincode Blocklist**: Comma-separated list of non-serviceable pincodes (e.g. `110006, 700001`). Disables order submission and warns customer in real-time.
3. **Shopify Order Tag**: Customize tag added to orders (e.g. `COD-Form`).

---

## 7. Stretch Goals Included

- ✅ **Mock SMS OTP Verification**: Sends a 6-digit verification code, logs the code server-side with prominent console output, emits `otp_sent` and `otp_verified` events, and verifies code before allowing order submission.
- ✅ **Abandoned Leads Recovery via WhatsApp Deep-Link**: Automatically lists dropped sessions where customer phone was captured, showing drop-off stage and providing a **1-Click WhatsApp Recovery link** (`https://wa.me/<phone>?text=<prefilled_message>`).

---

## 8. What We Would Do Next with More Time

1. **Shopify Admin GraphQL Order Create (`orderCreate`)**: Transition fully to GraphQL mutation API for bulk variant checks and automatic inventory reservation.
2. **Live SMS Gateway Integration**: Plug in Twilio / Kaleyra / Gupshup API with SMS rate-limiting, DLT template registration, and auto-read OTP WebOTP API on mobile.
3. **Redis-backed Distributed Locks (Redlock)**: Replace single-node SQLite locks with Redis locks for multi-instance horizontal scaling.
4. **Postcode Auto-fill via India Post Postal API**: Auto-populate City and State upon entering a 6-digit Indian PIN code to reduce address drop-off.
5. **Address Intelligence & RTO Risk Scoring**: Implement machine learning scoring based on phone carrier data, past COD return-to-origin history, and address completeness.

---

## 9. 3–5 Minute Screen Recording Script

When recording the submission video:
1. **0:00 - 0:45 (Storefront Checkout):** Open `http://localhost:3000/demo`, click "⚡ Cash on Delivery (COD)". Show phone normalization by entering `9876543210`. Complete address and click "Send OTP".
2. **0:45 - 1:30 (Order Placement & Idempotency):** Show server terminal output displaying `[MOCK SMS SERVICE] OTP Code: >>> XXXXXX <<<`. Enter OTP, click "Complete Order". Show the confirmed Order Number (`#1001`).
3. **1:30 - 2:30 (Shopify Admin / Orders List):** Open `http://localhost:3000/dashboard` $\rightarrow$ "Real COD Orders" tab. Show order tagged `COD-Form` with exact totals, customer info, and timestamp.
4. **2:30 - 3:30 (Funnel Analytics & Abandoned Session):** Go back to `/demo`, open the form in a new incognito window, enter name & phone number `9876512345`, but close the tab (abandon at address).
5. **3:30 - 4:30 (Merchant Dashboard & WhatsApp Recovery):** Refresh Dashboard $\rightarrow$ Show updated Funnel Analytics with 1 drop at `address_filled`. Go to "Abandoned Leads Recovery" tab $\rightarrow$ Show the abandoned lead with phone number and click the **"Recover via WhatsApp"** button.
