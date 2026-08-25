# Client Onboarding — Groundwork intake (shared engine)

A guided, upload-capable intake that turns a client's answers into a **software-
spec-style project brief**, an **e-signed services agreement**, and a **Stripe
deposit + recurring care-plan** payment — inside the Groundwork client portal.

- Client wizard: **`/onboarding/?product=groundwork`** (Groundwork is the default)
- Studio admin: **`/onboarding/admin.html`**
- Same Supabase project as the portals (`ekogelnbhggyrychfrta`); all objects are
  `onb_`-namespaced and RLS-guarded (client sees only their own; admin sees all).

**Scope:** this is a web/local-business intake — it maps to **Groundwork**.
DeSmit Designs (fabrication / CAD / laser / 3D print) uses its own portal
"Request a service" quote flow instead, so only Groundwork links to onboarding.
The engine is still product-parameterized (`?product=`), so a dedicated DeSmit
fabrication-brief template can be added later on the same engine without rework.

**Quote-first flow.** The client fills the brief and hits **Submit brief for
review**; the **agreement and deposit stay locked** until you review the scope in
`/onboarding/admin.html`, set the real deposit, and flip the intake to
**`accepted`**. The client's screen unlocks live (Realtime) — no refresh — and you
can also decline. This matches how custom work is normally quoted.

The client must be **signed into the Groundwork portal first** (the onboarding page
shares that session). The entry button is already wired into the Groundwork portal
dashboard and its "no setup yet" screen.

---

## What's in here

```
onboarding/
├─ index.html          client wizard host
├─ app.js              wizard engine (7 steps, autosave, uploads, e-sign, checkout)
├─ spec-template.js    the spec/brand/package definitions (edit copy & options here)
├─ onboarding.css      styles (accent themed per product)
├─ config.js           Supabase URL + anon key + product branding (safe to ship)
├─ admin.html / admin.js   studio console (list intakes, view brief, set the real
│                          deposit, flip status to `accepted` to unlock sign + pay)
└─ _backend/
   ├─ 010_onboarding.sql   schema + Storage bucket + RLS + autosave RPC
   ├─ onb-sign/index.ts     records the e-signature (Verify JWT ON)
   ├─ onb-checkout/index.ts creates the Stripe Checkout Session (Verify JWT ON)
   ├─ onb-webhook/index.ts  Stripe webhook → payment status (Verify JWT OFF)
   ├─ onb-concierge/index.ts intake concierge: auto-acks the client + Claude
   │                        review + draft reply to you (Verify JWT ON)
   ├─ onb-notify/index.ts   simple submit email — SUPERSEDED by onb-concierge
   └─ onb-lookup/index.ts   Google Places business autofill (Verify JWT ON)
```

---

## Owner setup (one time)

Everything is built. These steps are the parts only the account owner can do.

### 1. Apply the schema
Run **`_backend/010_onboarding.sql`** then **`_backend/011_onboarding_bridge.sql`**
against the shared project:
- **Dashboard:** SQL Editor → paste → Run, **or**
- **Claude + MCP:** point the Supabase MCP at `ekogelnbhggyrychfrta` and
  `apply_migration`.

`010` creates `onb_intakes`, `onb_assets`, `onb_events`, the **private
`onboarding` Storage bucket** with per-user RLS, the `onb_save_draft` RPC, and
turns on Realtime. It depends on `dd_is_admin()` (from `001_dd_portal.sql`).

`011` is the **onboard → in-service bridge**: it adds link/billing columns to
`gw_clients` and the admin-only `onb_accept_and_provision` RPC. It depends on the
Groundwork tables (`001`/`002` gw_portal) also being applied.

### 2. Deploy the three Edge Functions
| Function | Verify JWT | Purpose |
|---|---|---|
| `onb-sign`     | **ON**  | records the click-through e-signature + emails a copy |
| `onb-checkout` | **ON**  | creates the Stripe Checkout Session |
| `onb-webhook`  | **OFF** | receives Stripe events (verified by signature instead) |
| `onb-concierge`| **ON**  | on submit: auto-acks the client + Claude review + draft reply to you |
| `onb-lookup`   | **ON**  | Google Places business autocomplete/autofill (Step 1) |

(`onb-notify` is the older, simpler "email you on submit" function — **superseded
by `onb-concierge`**, which does everything it did plus the review. Deploy the
concierge; you can skip `onb-notify`.)

CLI: put each at `supabase/functions/<name>/index.ts` then
`supabase functions deploy onb-sign` /
`supabase functions deploy onb-checkout` /
`supabase functions deploy onb-concierge` /
`supabase functions deploy onb-lookup` /
`supabase functions deploy onb-webhook --no-verify-jwt`.

### 3. Set the secrets (Project Settings ▸ Edge Functions ▸ Secrets)
```
STRIPE_SECRET_KEY      = sk_live_…        # or sk_test_… while testing
STRIPE_WEBHOOK_SECRET  = whsec_…          # from the webhook you create in step 4
RESEND_API_KEY         = re_…             # emails: acks, signed agreement, owner review
ANTHROPIC_API_KEY      = sk-ant-…         # concierge AI review/draft (same key the assistants use)
ANTHROPIC_MODEL        = claude-sonnet-5  # optional override for the concierge model
GOOGLE_PLACES_API_KEY  = AIza…            # optional: Step-1 business autofill (see below)
ALLOWED_ORIGINS        = https://lostpinescreative.com,https://www.lostpinescreative.com
OWNER_EMAIL            = desmitdesignz@gmail.com   # signature copies + new-brief notifications
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

**Business autofill (optional):** to enable Step 1's "Find your business" lookup,
create a Google Cloud project → enable **Places API (New)** → make an API key and
set it as `GOOGLE_PLACES_API_KEY`. Two guards are **required** before going live:
1. **Restrict the key** to the Places API (New) only.
2. **Set a daily quota cap** on the key (Google Cloud → APIs & Services → Quotas)
   — this is the authoritative spend backstop if anything else fails.

The key stays server-side (only `onb-lookup` uses it), and the function
re-verifies the caller is a real signed-in user (`/auth/v1/user`) plus a per-user
rate cap — platform "Verify JWT ON" alone is not enough because the public anon
key passes it. Cost is ~a few cents per completed lookup (an autocomplete session
+ one details call), and the wizard sends a session token so it bills as one
session. Without the key the field says "lookup isn't set up — just fill in the
fields," and everything else works.

### 4. Create the Stripe webhook
Stripe Dashboard ▸ Developers ▸ Webhooks ▸ **Add endpoint**:
- URL: `https://ekogelnbhggyrychfrta.supabase.co/functions/v1/onb-webhook`
- Events: `checkout.session.completed`, `invoice.paid`,
  `invoice.payment_failed`, `customer.subscription.deleted`
- Copy the **Signing secret** into `STRIPE_WEBHOOK_SECRET` (step 3).

### 5. Add the redirect URL for Auth (so Stripe return lands cleanly)
Authentication ▸ URL Configuration ▸ Redirect URLs — add:
```
https://lostpinescreative.com/onboarding/
```
(The portal redirect URLs from the earlier setup should already be present.)

### 6. Commit & deploy the site
Push `main` — GitHub Pages serves `/onboarding/`. Navigations are network-first,
so the new pages appear immediately; if a returning visitor sees a stale asset
once, a single refresh fixes it.

---

## How the money works

- **Deposit** — a one-time **booking deposit** applied to the project total,
  defaulting to **50% of each tier's floor price** (Starter $750 → $375,
  Foundation $1,500 → $750, Growth $3,500 → $1,750). The balance is billed on
  delivery/launch. **Full Build and "not sure yet" are scoped from a discovery
  workshop and are never auto-charged** (→ $0 = the client is told the studio
  will send a quote). The amount is **server-authoritative** (`DEPOSIT_BY_PACKAGE`
  in `onb-checkout/index.ts`); an admin-set `onb_intakes.deposit_amount` (editable
  in `/onboarding/admin.html`) **always wins**, so once you quote a client the
  exact figure, that is what they pay.
- **Care plan** — a recurring **subscription** (`essential` $99/mo, `growth`
  $300/mo; annual = 10× monthly = 2 months free, an incentive not in the manuals —
  set annual to 12× to disable). `partner` is custom (no auto subscription).
  Amounts live in `CARE_MONTHLY` in `onb-checkout/index.ts`.
- Deposit + care plan are combined into **one** Checkout Session (the deposit is
  added to the subscription's first invoice). No card data ever touches our code.
- `pay_status` is only ever written by `onb-webhook` — never the browser.

## The e-signature

Click-through under the U.S. E-SIGN Act: the client types their full legal name
and checks a box. For integrity, `onb-sign` **generates the canonical agreement
text server-side** from the intake (`buildAgreement()` — it ignores whatever the
browser sent), hashes THAT (**SHA-256**), and stores the text + hash + typed
**name** + **timestamp** + full **X-Forwarded-For** + **user-agent**, then emails
a copy. Signing is **write-once** (an executed signature can't be overwritten) and
only allowed once the intake is **`accepted`**. The browser copy the client sees
(`buildAgreementText()` in `app.js`) mirrors the server text — **keep the two in
sync and bump `AGREEMENT_VERSION`** (in `config.js`, `app.js`, and
`onb-sign/index.ts`) whenever the wording changes.

## Editing the questions

All the sections, features, brand choices, packages and care plans are data in
**`spec-template.js`** — add/rename/reorder there and both the wizard and admin
brief update. Every design and spec item already supports a **"let the designer
decide"** opt-out. The **live estimate** the wizard shows (a soft price *range*
that updates as the client toggles items — never a binding total; the studio
still confirms the real quote) is also tuned here via `PACKAGE_BASE` (per-tier
base range) and `ADDON` (incremental per-item ranges).

## Data model

| table | purpose |
|---|---|
| `onb_intakes` | one row per onboarding: business info, brand prefs, the `spec` json, package/billing, contract proof, Stripe ids/status |
| `onb_assets` | metadata for uploaded logo/photos/inspiration (files live in the private `onboarding` bucket) |
| `onb_events` | append-only audit: saved / submitted / signed / paid / admin updates |

Status flow: `draft → submitted → in_review → accepted` (`declined` any time).
The client can move `draft → submitted`; everything else is admin-driven.

## Customer lifecycle (onboard → in-service → offboard)

**Onboard (`onb_*`) → in-service (`gw_*`) is bridged.** In the onboarding admin,
**"Accept & create Groundwork client"** calls `onb_accept_and_provision`, which:
sets the deposit + accepts the intake, creates a linked `gw_clients` record
(business, contact, care plan, Stripe customer/subscription ids), **seeds
`gw_integrations` from the chosen spec** (plus Website + Google Business Profile),
adds an empty `gw_settings` row, and sets `onb_intakes.project_id = gw_clients.id`.
It's idempotent — re-clicking returns the existing client, never a duplicate.
From then on, the Groundwork portal/admin is the in-service home; billing state
(`pay_status`, subscription id) is kept live on `gw_clients` by the Stripe webhook.

**Offboard** is the manual **SOP-014 / CHK-014** (in the LPC repo): export the
client slice, transfer client-owned assets, revoke access, rotate secrets, then
delete. It now covers the onboarding footprint — **Hook E** exports/deletes
`onb_*` + the uploaded files in the `onboarding` Storage bucket (the blobs do NOT
cascade with the DB, so E3 removes them explicitly), and **Hook F** cancels the
Stripe care-plan subscription so billing stops when service does.

**Consent:** the Review step captures a **required privacy consent** (linked to
`/privacy.html`) plus an **optional SMS opt-in** before the brief can be
submitted; both are timestamped into `onb_intakes.about` and shown in the admin.

**Intake concierge (`onb-concierge`):** the moment a client submits, the concierge
(1) **auto-acknowledges the prospect** with an on-brand "we've got it, here's
what happens next" email, (2) has **Claude review the brief** — fit, suggested
scope/deposit, gaps to ask, red flags — and (3) emails **you** that review plus a
**ready-to-send draft reply** (reply-to set to the client). Human-in-the-loop by
design: the prospect only ever gets the automatic acknowledgement; the personal
reply is yours to approve and send. Degrades gracefully — no `ANTHROPIC_API_KEY`
→ you still get the brief + ack; no `RESEND_API_KEY` → no emails, brief still in
the admin. It's fired best-effort from the browser on submit; for guaranteed
firing you can later point a Supabase **Database Webhook** (on `onb_intakes`
UPDATE → status `submitted`) at it instead.
