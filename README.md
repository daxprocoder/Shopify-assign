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

## 3. Idempotency Mechanism

Cash-on-Delivery apps face high network flakiness, double-taps on mobile, and duplicate retries. We prevent duplicate order creation via a **4-stage atomic state machine**:

1. **Unique Idempotency Key**: Each checkout lifecycle generates an `idempotency_key` (`idem_<sessionId>_<timestamp>`).
2. **Database Constraint & Lock**: The `orders` table enforces a `UNIQUE(idempotency_key)` constraint.
3. **In-Flight Concurrency Guard (`PROCESSING` state)**:
   - When a submit request arrives, an atomic record is inserted with `status: 'PROCESSING'`.
   - If a duplicate concurrent request arrives while the first is in-flight, it receives HTTP `409 Conflict` (`in_flight: true`) or waits for the resolution.
4. **Transparent Replay on Success**:
   - If the key is already marked `status: 'SUCCESS'`, the backend immediately returns the cached Shopify order payload (`orderNumber`, `shopifyOrderId`, `isDuplicate: true`) with HTTP 200 without re-calling Shopify API.
5. **Safe Retry on Failure**:
   - If a previous attempt suffered an address error or transient network issue, the order status transitions back to `PROCESSING` to allow the customer to fix the error and resubmit without generating two orders.

---

## 4. Funnel-Integrity & Truthful Analytics

Many apps present misleading funnel metrics by counting every keystroke, modal reopen, or page refresh. We guarantee truthfulness through the following design:

### The 5 Funnel Milestones:
1. `form_opened`: Customer clicked "Buy with COD"; popup rendered.
2. `phone_entered`: A valid 10-digit Indian phone was completed (fired once on completion/blur, **not per keystroke**).
3. `address_filled`: Address Line 1, City, State, and valid PIN code were filled to submittable state.
4. `submit_clicked`: Customer pressed the "Complete Cash on Delivery Order" button.
5. `order_created`: Server confirmed the Shopify order. **Mathematically guaranteed to equal real orders ($COUNT(DISTINCT\ orders)$) — never more.**

### Deduplication Guarantee:
- Every event is bound to an immutable `session_id`.
- The funnel aggregation runs `COUNT(DISTINCT session_id)` per milestone within the selected date range (`today`, `7d`, `30d`).
- If a customer opens the modal 3 times, changes their address twice, or retries a failed submit, it counts as **exactly 1 session** at each completed step.

### Drop-Off Analysis:
- Calculates step-to-step conversion $\%$ and drop-off $\%$:
  $$\text{Step Drop-off} = \left(1 - \frac{\text{Count}(\text{Step}_{n})}{\text{Count}(\text{Step}_{n-1})}\right) \times 100\%$$
- **Automatic Major Drop Point Alert**: Identifies the step with the highest drop-off rate to alert the merchant (e.g. *Biggest drop-off: Address Filled $\rightarrow$ Submit Clicked*).

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

---

## 6. Merchant Settings Impact on Storefront

Merchants can configure live rules from the Dashboard (`/dashboard`):
1. **COD Handling Fee (INR)**: Adds an extra convenience fee (e.g. ₹49.00) calculated live in the modal price breakdown and added as a custom Shopify shipping line.
2. **Pincode Blocklist**: Comma-separated list of non-serviceable pincodes (e.g. `110006, 700001`). Disables order submission and warns customer in real-time.
3. **SMS OTP Verification**: Toggle mock SMS OTP verification on or off before order confirmation.
4. **Shopify Order Tag**: Customize tag added to orders (e.g. `COD-Form`).

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
