# Shopify COD Quick-Order Engine

> **Cash on Delivery checkout & merchant funnel intelligence — built for Shopify India merchants.**

A production-grade Node.js application that replaces Shopify's native checkout with a lightweight, 1-click COD modal. Includes truthful funnel analytics, idempotency-guaranteed order creation, HMAC-verified webhooks, and an abandoned-lead recovery hub.

---

## Table of Contents

- [Project Summary](#project-summary)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Setup & Installation](#setup--installation)
- [Environment Variables](#environment-variables)
- [Running the App](#running-the-app)
- [Running Tests](#running-tests)
- [Architecture Overview](#architecture-overview)
- [System Design](#system-design)
- [Idempotency Engine](#idempotency-engine)
- [Key Features](#key-features)
- [API Reference](#api-reference)

---

## Project Summary

Indian e-commerce has a dominant cash-on-delivery market. Native Shopify checkout is heavy, slow, and not optimised for COD workflows. This app solves that with a purpose-built solution.

| Problem | Solution |
|---|---|
| Long native Shopify checkout | Lightweight 2-step COD modal injected into product pages |
| Duplicate orders from double-clicks / retries | Atomic SQLite idempotency lock — orders created **exactly once** |
| Inflated funnel numbers from pixel tracking | Server-side, session-deduplicated funnel aggregation |
| No recovery for abandoned leads | WhatsApp deep-link recovery for every dropped session |
| Payment webhook security | HMAC-SHA256 constant-time signature verification |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime** | Node.js v18+ |
| **Framework** | Express.js v5 |
| **Database** | SQLite (WAL mode) via `better-sqlite3` |
| **ORM** | Drizzle ORM |
| **Storefront Client** | Vanilla JS / CSS (zero-dependency modal) |
| **Shopify Integration** | Shopify Admin REST API 2024-04 |
| **Security** | `crypto.timingSafeEqual` HMAC-SHA256, `express-rate-limit` |
| **ID Generation** | `uuid` |
| **Testing** | Custom Node.js test harness (in-memory SQLite) |

---

## Project Structure

```
Shopify-assign/
├── src/
│   ├── server.js                       # Express app entry point & all API routes
│   ├── db/
│   │   ├── index.js                    # Database connection (WAL mode)
│   │   └── schema.js                   # Drizzle ORM table definitions
│   ├── services/
│   │   ├── idempotency.js              # Atomic order lock & state machine engine
│   │   ├── funnel.js                   # Truthful funnel aggregation queries
│   │   ├── shopify.js                  # Shopify Admin REST API client
│   │   └── otp.js                      # OTP generation utility
│   └── utils/
│       ├── phone.js                    # Indian phone number normalization (E.164)
│       ├── hmac.js                     # HMAC-SHA256 webhook verifier
│       └── rate-limiter.js             # IP & phone-level rate limiting
├── public/
│   ├── dashboard.html                  # Merchant intelligence dashboard (UI)
│   ├── demo.html                       # Local storefront PDP simulator
│   └── storefront/
│       ├── cod-modal.js                # Storefront COD modal injected on PDP
│       └── cod-modal.css               # Modal styles
├── extensions/
│   └── cod-form-extension/             # Shopify Theme App Extension
├── tests/
│   └── test-funnel-and-idempotency.js  # Automated verification suite
├── .env.example                        # Environment variable template
├── cod_app.db                          # SQLite database file (WAL mode)
└── package.json
```

---

## Setup & Installation

### Prerequisites

- **Node.js** v18.0.0 or higher
- A **Shopify Development Store** (e.g. `your-store.myshopify.com`)
- A **Shopify Admin Access Token** with the following scopes:
  - `write_orders`, `read_orders`
  - `write_products`, `read_products`

### 1. Clone the repository

```bash
git clone https://github.com/daxprocoder/Shopify-assign.git
cd Shopify-assign
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in your values (see [Environment Variables](#environment-variables) below).

---

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `PORT` | Port the Express server listens on | `3000` |
| `SHOPIFY_SHOP_DOMAIN` | Your Shopify store domain | `your-store.myshopify.com` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Admin API access token | `shpat_xxxxxxxxxxxx` |
| `SHOPIFY_API_VERSION` | Shopify API version | `2024-04` |
| `SHOPIFY_WEBHOOK_SECRET` | Webhook signing secret for HMAC verification | `your_webhook_secret` |

```env
PORT=3000
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_VERSION=2024-04
SHOPIFY_WEBHOOK_SECRET=your_webhook_signing_secret_here
```

---

## Running the App

```bash
npm start
```

| URL | Description |
|---|---|
| `http://localhost:3000/demo` | Storefront Product Page simulator |
| `http://localhost:3000/dashboard` | Merchant Intelligence Dashboard |

---

## Running Tests

### 1. In-Memory Unit & Functional Suite
Runs against an isolated in-memory SQLite database (`:memory:`):

```bash
npm test
```

Verifies:
- Phone normalization edge cases (`+91`, `0`, prefix check)
- Funnel event deduplication & session stitching
- Idempotency lock under concurrent double-clicks
- Abandoned lead recovery with WhatsApp deep-links
- HMAC-SHA256 constant-time webhook validation
- Stage-by-stage idempotency trace logging

### 2. K6 Load, Concurrency & Security Suite
Runs automated high-concurrency load and security verification with real-time throughput metrics:

```bash
npm run test:k6
```

Generates a detailed summary report in [`tests/k6-test-report.md`](file:///d:/Github/Shopify-assign/tests/k6-test-report.md) and [`tests/k6-summary-report.json`](file:///d:/Github/Shopify-assign/tests/k6-summary-report.json).

---

## Architecture Overview

The app is composed of five layers that work together end-to-end:

```
+-------------------------------------------------+
|           SHOPIFY STOREFRONT / PDP              |
|  Product Page  ->  "Buy with COD" button        |
+---------------------+---------------------------+
                      |  (Opens COD popup modal)
                      v
+-------------------------------------------------+
|          STOREFRONT MODAL CLIENT                |
|  - Indian Phone Normalization (+91 E.164)       |
|  - Session Stitching (sessionStorage)           |
|  - Idempotency Key Generation                   |
+---------------------+---------------------------+
                      |  HTTPS POST /api/cod/order
                      v
+-------------------------------------------------+
|        EXPRESS.JS BACKEND GATEWAY               |
|  - IP Rate Limiting & Abuse Prevention          |
|  - Request Validation                           |
|  - HMAC-SHA256 Webhook Signature Verification   |
+---------------------+---------------------------+
                      v
+-------------------------------------------------+
|       IDEMPOTENCY & LOCK ENGINE                 |
|  - Atomic SQLite transaction lock               |
|  - Duplicate key -> 0ms cached replay           |
|  - Stage-by-stage waterfall trace logging       |
+----------+--------------------+------------------+
           |                    |
           v                    v
+-------------------+  +----------------------+
| SHOPIFY ADMIN     |  | SQLITE DATABASE WAL  |
| REST API 2024-04  |  | (Drizzle ORM)        |
|                   |  |                      |
| - Order creation  |  | - sessions           |
| - COD-Form tag    |  | - funnel_events      |
| - 10s timeout     |  | - orders             |
|   guard           |  | - idempotency_traces |
+----------+--------+  | - webhooks           |
           |            +----------+-----------+
           +------------+----------+
                        v
+-------------------------------------------------+
|     MERCHANT INTELLIGENCE DASHBOARD             |
|  KPI Cards | Funnel Cylinders | Waterfall       |
|  WhatsApp Recovery | Webhooks Feed              |
+-------------------------------------------------+
```

### Architecture Summary

**Storefront Layer** — A zero-dependency vanilla JS modal injected into Shopify product pages via Theme App Extension. Every customer gets a persistent `sessionId` via `sessionStorage`, which gates all analytics events to prevent double-counting. Before calling the backend, the client generates a deterministic `idempotencyKey` tied to the session and timestamp.

**Backend Gateway** — An Express.js server that validates requests, applies IP-level rate limiting via `express-rate-limit`, and routes orders through the idempotency engine.

**Idempotency Engine** — A lightweight state machine backed by SQLite. It performs an atomic `INSERT ... WHERE NOT EXISTS` to acquire a `PROCESSING` lock before calling the Shopify Admin REST API. On success, updates to `SUCCESS`. On any duplicate request, returns the cached order in **0 milliseconds** — no Shopify API call made.

**Shopify Integration** — REST API calls to create COD orders tagged `COD-Form` with `financial_status: pending`, protected by a 10-second `AbortController` timeout.

**Merchant Dashboard** — Renders live funnel metrics, idempotency waterfall traces, abandoned leads with WhatsApp recovery links, and a verified webhook log — all from the same SQLite database.

---

## System Design

### Database Schema

| Table | Purpose |
|---|---|
| `sessions` | One row per unique customer shopping journey |
| `funnel_events` | Deduplicated milestone events per session (`form_opened`, `phone_entered`, `address_filled`, `submit_clicked`, `order_created`) |
| `orders` | Order records with `UNIQUE(idempotency_key)` constraint |
| `idempotency_traces` | Stage-by-stage waterfall timeline for each order attempt |
| `webhooks` | Cryptographically verified Shopify payment webhook log |

### Funnel Truthfulness

All funnel metrics are computed using `COUNT(DISTINCT session_id)` — never raw row counts. This eliminates three common failure modes:

| Edge Case | Naive Tracker | This App |
|---|---|---|
| Customer opens modal 3 times | 3 sessions (+200% bloat) | Exactly 1 session |
| Submit fails -> user retries | 2 submits / 1 order (50% conversion) | 1 submit / 1 order (100%) |
| Network drops before thank-you page | 0 orders in analytics | 1 confirmed order |

The SQL backing every funnel step:

```sql
SELECT COUNT(DISTINCT session_id) AS step_count
FROM funnel_events
WHERE event_name = 'form_opened' AND shop_domain = ?
```

### Indian Phone Normalization

All phone numbers are normalized server-side to E.164 `+91XXXXXXXXXX` before storage:

```
+91 98765 43210  ->  +919876543210
919876543210     ->  +919876543210
09876543210      ->  +919876543210
```

Carrier prefix validation enforces that the first digit after `+91` is `6`, `7`, `8`, or `9` (Indian mobile ranges only).

---

## Idempotency Engine

Guarantees that every unique customer checkout attempt creates **exactly one** Shopify order regardless of network retries, double-clicks, or browser refreshes.

**State machine:**

```
 NEW REQUEST                          DUPLICATE REQUEST
      |                                      |
      v                                      v
ATOMIC_LOCK_ACQUIRED              DUPLICATE_CACHE_HIT
(status: PROCESSING)              (return cached order,
      |                            0ms Shopify API call)
      v
SHOPIFY_DISPATCH
(POST Admin API, 10s AbortController timeout)
      |
      v
SHOPIFY_CONFIRMED
(HTTP 201 - Order created)
      |
      v
DB_COMMITTED_SUCCESS
(status: SUCCESS)
```

Every stage is recorded in `idempotency_traces` and visualised as a waterfall timeline on the merchant dashboard.

**Failure handling:**

| Failure | Idempotency Behavior |
|---|---|
| Shopify API timeout (>10s) | Status set to `TIMED_OUT`; next retry gets a fresh attempt |
| Shopify API error (5xx) | Status set to `FAILED`; retries allowed |
| Double-click while in-flight | Second request returns first request's result |

---

## Key Features

### 1-Click COD Checkout Modal
A multi-step form (Contact → Address → Confirm) injected into Shopify product pages. No native checkout redirect. Works on mobile and desktop.

### Idempotency-Guaranteed Order Creation
SQLite atomic locks prevent duplicate Shopify orders. Duplicate requests return a cached response in 0ms — no external API call.

### Truthful Funnel Analytics
Server-side, session-deduplicated funnel stages. Conversion rate is always mathematically correct: `Orders ≡ order_created events`.

### Abandoned Lead Recovery
Sessions where a customer entered their phone number but did not complete the order are surfaced in the dashboard with a 1-click WhatsApp recovery link (`https://wa.me/<phone>?text=<prefilled_message>`).

### HMAC-SHA256 Webhook Verification
Payment webhooks from Shopify are verified using `crypto.timingSafeEqual` constant-time comparison. Forged or replayed webhooks are rejected with `401 Unauthorized`.

### Merchant Configurable Settings
From the dashboard, merchants can configure:
- **COD Handling Fee (INR)** — added as a line item on the Shopify order
- **Pincode Blocklist** — comma-separated non-serviceable pincodes with real-time validation
- **Order Tag** — custom tag applied to all COD orders in Shopify Admin

### Rate Limiting & Abuse Prevention
- IP-level rate limiter via `express-rate-limit`
- Per-phone submission throttler to block COD bot abuse
- Returns `HTTP 429` with a clear error message

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/cod/order` | Place a COD order (idempotency-protected) |
| `POST` | `/api/event` | Record a storefront funnel milestone event |
| `GET` | `/api/funnel` | Fetch aggregated funnel analytics |
| `GET` | `/api/orders` | List all COD orders |
| `GET` | `/api/abandoned-leads` | List abandoned sessions with WhatsApp links |
| `GET` | `/api/idempotency-traces` | Fetch waterfall trace logs |
| `POST` | `/api/webhooks/orders/paid` | Receive & verify Shopify payment webhooks |
| `GET` | `/api/settings` | Get merchant configuration |
| `POST` | `/api/settings` | Update merchant configuration |
| `GET` | `/dashboard` | Merchant Intelligence Dashboard (HTML) |
| `GET` | `/demo` | Storefront PDP Simulator (HTML) |
