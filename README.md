# 🚀 Shopify COD Quick-Order Engine & Merchant Intelligence Dashboard

A production-grade, highly truthful **Cash on Delivery (COD) Checkout & Merchant Funnel Intelligence App** built for Shopify India merchants. Features 1-click storefront checkout with Indian phone normalization, zero-duplicate idempotency locking, HMAC-SHA256 payment webhooks, and a modern **Donezo Forest Green** merchant analytics dashboard.

---

## 🏗️ Architecture in 10 Lines

1. **Storefront Modal (`public/storefront/`):** Lightweight, zero-dependency vanilla JS/CSS modal injected into Shopify Product Pages via Theme App Extension or ScriptTag.
2. **Indian Phone Normalization (`src/utils/phone.js`):** Client & server sanitize all formats (`+91 98765 43210`, `919876543210`, `09876543210`) into standard E.164 `+919876543210` and validate carrier prefixes `[6-9]`.
3. **Session Stitching (`sessionStorage`):** Every customer journey receives a persistent `sessionId`, preventing multiple modal opens or page reloads from corrupting top-of-funnel analytics.
4. **Idempotency Engine (`src/services/idempotency.js`):** Atomic SQLite transaction lock (`status: 'PROCESSING'`) ensures concurrent double-clicks or retries create **exactly one** Shopify order with 0ms duplicate replay overhead.
5. **Shopify Admin Integration (`src/services/shopify.js`):** Direct REST API integration with 10-second `AbortController` timeout protection, tagging orders as `COD-Form` with `financial_status: 'pending'`.
6. **Payment Webhooks & HMAC (`src/utils/hmac.js`):** `POST /api/webhooks/orders/paid` validates `X-Shopify-Hmac-Sha256` signatures using constant-time `crypto.timingSafeEqual` to audit payments securely.
7. **Database Layer (`src/db/`):** Local SQLite with WAL mode (`better-sqlite3` + `Drizzle ORM`) for high-throughput concurrency and sub-millisecond query execution.
8. **Truthful Funnel Aggregation (`src/services/funnel.js`):** Calculates distinct session milestones, truthful conversion rates, and automatically detects major drop-off points.
9. **Abandoned Lead Recovery:** Captures dropped phone leads at Step 2 with automatic 1-click WhatsApp deep-links (`https://wa.me/<phone>?text=...`).
10. **Donezo Merchant Dashboard (`public/dashboard.html`):** Dark forest green bento-grid dashboard with live funnel cylinder charts, idempotency waterfall traces, and real-time order feeds.

---

## 🏛️ Comprehensive System Architecture

```
                                 +-------------------------------------------------------------+
                                 |                  SHOPIFY STOREFRONT / PDP                   |
                                 |  [ Product Page ] ---> [ ⚡ Buy with COD Trigger Button ]     |
                                 +------------------------------+------------------------------+
                                                                |
                                                 (Opens One-Click Popup Modal)
                                                                |
                                                                v
                                 +-------------------------------------------------------------+
                                 |                   STOREFRONT COD CLIENT                     |
                                 |  • Indian Phone Normalization (+91 98765 43210 -> Canonical) |
                                 |  • In-Memory Milestone Guard (Prevents Duplicate Events)     |
                                 |  • Deterministic Idempotency Key (idem_<sess>_<time>)       |
                                 +------------------------------+------------------------------+
                                                                |
                                               HTTPS POST /api/cod/order & /event
                                                                |
                                                                v
+-------------------------------------------------------------------------------------------------------------------------------+
|                                                    EXPRESS BACKEND GATEWAY                                                    |
|                                                                                                                               |
|   [ Security & Rate Limiting ] ---> [ Request Validation ] ---> [ HMAC-SHA256 Signature Audit (crypto.timingSafeEqual) ]      |
+---------------------------------------------------------------+---------------------------------------------------------------+
                                                                |
                                                                v
                                 +-------------------------------------------------------------+
                                 |                 IDEMPOTENCY & LOCK ENGINE                   |
                                 |                                                             |
                                 |  1. Ingress Key Check in SQLite                             |
                                 |  2. If Key Exists & SUCCESS -> Return 0ms Cached Order Replay|
                                 |  3. If New Key -> Acquire Atomic Lock ('PROCESSING')        |
                                 |  4. Stage-by-Stage Trace Logging (Waterfall Timeline)       |
                                 +------------------------------+------------------------------+
                                                                |
                                        +-----------------------+-----------------------+
                                        |                                               |
                                        v                                               v
         +----------------------------------------------+        +----------------------------------------------+
         |           SHOPIFY ADMIN REST API             |        |             SQLITE DATABASE (WAL)            |
         |  POST /admin/api/2024-04/orders.json         |        |  (Drizzle ORM + better-sqlite3)              |
         |                                              |        |                                              |
         |  • 10s AbortController Timeout Guard         |        |  • `sessions` (Distinct customer journeys)   |
         |  • Tag: 'COD-Form'                           |        |  • `funnel_events` (Deduplicated milestones) |
         |  • Status: 'pending'                         |        |  • `orders` (UNIQUE idempotency_key)         |
         |  • Custom COD Fee Line Item                  |        |  • `idempotency_traces` (Waterfall metrics)  |
         |  • Returns Order #1001 (HTTP 201 Created)    |        |  • `webhooks` (HMAC cryptographic audit)     |
         +----------------------------------------------+        +----------------------------------------------+
                                        |                                               |
                                        +-----------------------+-----------------------+
                                                                |
                                                                v
+-------------------------------------------------------------------------------------------------------------------------------+
|                                           DONEZO MERCHANT INTELLIGENCE DASHBOARD                                              |
|                                                                                                                               |
|   [ 4 Bento KPI Cards ]  |  [ Funnel Cylinders ]  |  [ Idempotency Waterfall ]  |  [ WhatsApp Recovery ]  |  [ Live Webhooks ] |
+-------------------------------------------------------------------------------------------------------------------------------+
```

---

## 🛠️ Quickstart & Local Setup

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher
- **Shopify Development Store**: (e.g. `daksh-cod-app.myshopify.com`)
- **Shopify Admin Access Token**: with `write_orders`, `read_orders`, `write_products`, `read_products` scopes.

### 2. Installation
```bash
# Clone the repository
git clone https://github.com/<your-username>/Shopify-assign.git
cd Shopify-assign

# Install dependencies
npm install
```

### 3. Environment Variables
Create a `.env` file in the root directory:
```env
PORT=3000
SHOPIFY_SHOP_DOMAIN=daksh-cod-app.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_VERSION=2024-04
SHOPIFY_WEBHOOK_SECRET=your_webhook_signing_secret_here
```

### 4. Running Locally
```bash
# Start the local server
npm start
```
- 📊 **Merchant Dashboard:** [http://localhost:3000/dashboard](http://localhost:3000/dashboard)
- 🛍️ **Storefront PDP Simulator:** [http://localhost:3000/demo](http://localhost:3000/demo)

### 5. Running Automated Verification Suite
Run the comprehensive test harness:
```bash
npm test
```
*Note: Tests run inside an isolated in-memory SQLite database (`:memory:`) and will never pollute your live database.*

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

* **The Failure Mode:** A shopper on mobile clicks "Buy with COD", closes the popup to re-check product specifications, re-opens the popup, selects a different quantity, closes it again, and finally re-opens it to complete the purchase. Naive analytics record 3 `form_opened` events, inflating top-of-funnel traffic by 300% and falsely making the checkout look broken.
* **How We Keep It Truthful:**
  1. **Session Stitching (`sessionStorage`):** The storefront client binds all interactions to an immutable `sessionId` (`sess_<random>_<timestamp>`) stored in browser session memory.
  2. **Client In-Memory Milestone Guards:** The client maintains an in-memory guard dictionary (`eventsFired.form_opened = true`). Subsequent modal re-opens in the same tab suppress duplicate network calls.
  3. **SQL Set-Theoretic Deduplication:** Even if client state resets (e.g. page refresh), the server funnel query aggregates strictly by distinct sessions:
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

## 4. Idempotency Waterfall & Trace Timeline

Below is the stage-by-stage lifecycle recorded in the SQLite database and visualized live on the Merchant Dashboard:

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

Merchants can configure live business rules from the Dashboard (`/dashboard`):
1. **COD Handling Fee (INR)**: Adds an extra convenience fee (e.g. ₹49.00) calculated live in the modal price breakdown and added as a custom Shopify shipping line.
2. **Pincode Blocklist**: Comma-separated list of non-serviceable pincodes (e.g. `110006, 700001`). Disables order submission and warns customer in real-time.
3. **Shopify Order Tag**: Customize tag added to orders (e.g. `COD-Form`).

---

## 7. Stretch Goals Included

- ✅ **Abandoned Leads Recovery via WhatsApp Deep-Link:** Automatically lists dropped sessions where customer phone was captured, showing drop-off stage and providing a 1-Click WhatsApp Recovery link (`https://wa.me/<phone>?text=<prefilled_message>`).
- ✅ **HMAC-SHA256 Webhook Verification:** Full audit pipeline verifying Shopify payment webhooks using `crypto.timingSafeEqual`.
- ✅ **Live Idempotency Waterfall Traces:** Stage-by-stage concurrency trace visualizer with duplicate absorption metrics.

---

## 8. What We Would Do Next with More Time

1. **Shopify Admin GraphQL Order Create (`orderCreate`):** Transition fully to GraphQL mutation API for bulk variant checks and automatic inventory reservation.
2. **Redis-backed Distributed Locks (Redlock):** Replace single-node SQLite locks with Redis locks for multi-region horizontal scaling.
3. **Postcode Auto-fill via India Post Postal API:** Auto-populate City and State upon entering a 6-digit Indian PIN code to reduce address friction.
4. **Address Intelligence & RTO Risk Scoring:** Machine learning model scoring customers based on past COD return-to-origin history and address completeness.

---

## 9. 3–5 Minute Screen Recording Script

When recording your demo video:

* **0:00 - 0:45 (Storefront Checkout):** Open `http://localhost:3000/demo`, click **"Buy with Cash on Delivery (COD)"**. Demonstrate Indian phone normalization by entering `98765 43210` $\rightarrow$ auto-formatted to `+919876543210`. Complete address and click **"Complete Cash on Delivery Order"**.
* **0:45 - 1:30 (Order Placement & Idempotency):** Show order confirmation `#1001`. Refresh the page or double-click to demonstrate that duplicate orders are intercepted and absorbed with 0ms external API overhead.
* **1:30 - 2:30 (Shopify Admin / Orders List):** Open `http://localhost:3000/dashboard` $\rightarrow$ **"COD Orders"** tab. Show the newly created order tagged `COD-Form` with exact totals, customer info, and timestamp.
* **2:30 - 3:30 (Funnel Analytics & Abandoned Session):** Go back to `/demo`, open the form in a new incognito window, enter name & phone number `9876512345`, but close the tab without submitting (abandon at address).
* **3:30 - 4:30 (Merchant Dashboard & WhatsApp Recovery):** Refresh Dashboard $\rightarrow$ Show updated Funnel Analytics with 1 drop at `address_filled`. Go to **"Recovery Leads"** tab $\rightarrow$ Show the abandoned lead with phone number and click the **"Recover via WhatsApp"** button.
