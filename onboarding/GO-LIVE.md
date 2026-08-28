# Onboarding — Go-Live Runbook & Test Checklist

Everything needed to take the onboarding module from "committed" to "taking real
money," in order. Do Parts 1–4 in **Stripe TEST mode** first; only flip to live
(Part 5) once every box in Part 4 passes.

Project: `ekogelnbhggyrychfrta` · Owner-only steps · Companion: `README.md`.

---

## Part 1 — Deploy (in order)

- [ ] **1. Apply SQL** — run `_backend/010_onboarding.sql` then
  `_backend/011_onboarding_bridge.sql` (SQL Editor or MCP `apply_migration`).
  Verify:
  ```sql
  select count(*) from public.onb_intakes;                 -- 0, no error
  select id from storage.buckets where id = 'onboarding';   -- 1 row
  select proname from pg_proc where proname in
    ('onb_save_draft','onb_accept_and_provision');          -- 2 rows
  ```
- [ ] **2. Deploy the 5 edge functions** with the right JWT setting:
  - `onb-sign`, `onb-checkout`, `onb-concierge`, `onb-lookup` → **Verify JWT ON**
  - `onb-webhook` → **Verify JWT OFF** (`--no-verify-jwt`)
  - (`onb-notify` is superseded by `onb-concierge` — skip it.)
- [ ] **3. Set secrets** (Project Settings ▸ Edge Functions ▸ Secrets). Start with
  **test** values:
  ```
  STRIPE_SECRET_KEY      = sk_test_…
  STRIPE_WEBHOOK_SECRET  = whsec_…            # from step 4
  RESEND_API_KEY         = re_…               # emails (acks, agreement, concierge)
  ANTHROPIC_API_KEY      = sk-ant-…           # concierge AI review (same key as the assistants)
  GOOGLE_PLACES_API_KEY  = AIza…              # optional (autofill)
  ALLOWED_ORIGINS        = https://lostpinescreative.com,https://www.lostpinescreative.com
  OWNER_EMAIL            = ddesmit@lostpinescreative.com
  ```
  (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)
- [ ] **4. Create the Stripe webhook** (TEST mode) → endpoint
  `https://ekogelnbhggyrychfrta.supabase.co/functions/v1/onb-webhook`, events:
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`.
  Copy the signing secret → `STRIPE_WEBHOOK_SECRET` (step 3).
- [ ] **5. Auth redirect URL** — Authentication ▸ URL Configuration ▸ add
  `https://lostpinescreative.com/onboarding/`.
- [ ] **6. Optional integrations:**
  - Google Places: enable **Places API (New)**, **restrict the key**, **set a
    daily quota cap**.
  - Resend: verify the `lostpinescreative.com` sending domain (SPF/DKIM) or
    emails land in spam / don't send.
- [ ] **7. Confirm `config.js`** points at the project (URL + anon key already
  filled) and **deploy the site** (push `main`).
- [ ] **8. Admin access** — you're admin via `dd_profiles.is_admin` already; if a
  fresh account, run the one-time bootstrap from the DeSmit README.

---

## Part 2 — End-to-end smoke test (Stripe TEST mode)

Use a **throwaway client account** (not your admin email) in one browser, and the
admin console in another. Stripe test card: **4242 4242 4242 4242**, any future
expiry/CVC/ZIP.

**Client — build the brief**
- [ ] Sign into the Groundwork portal with the test account → "Start your project
  brief" opens `/onboarding/?product=groundwork`
- [ ] Step 1: (if Google key set) "Find your business" → pick a listing →
  name/phone/address/hours/website autofill; else fields are editable
- [ ] Type in a field, wait ~1s → header shows "Saved"; **reload** → values persist
- [ ] Step 2: drag-drop an image → thumbnail appears; add a brand color; pick a
  design option and a "let the designer decide"
- [ ] Step 3: toggle a few sections/integrations → the **estimate** at the bottom
  updates live
- [ ] Step 4: pick a package + care plan → full estimate shows base + care/mo
- [ ] Step 5 (Review): the doc renders; the **privacy checkbox is required** — the
  "Submit brief for review" button is disabled until it's ticked
- [ ] Tick consent → **Submit** → banner flips to "Submitted — we're reviewing"
- [ ] **Concierge fired** — the test client's inbox gets an on-brand "We've got
  your brief" acknowledgement (if Resend set)

**Studio — review & provision**
- [ ] You receive the **concierge email** with the Claude review + a draft reply
  (reply-to = the client) and an "Open in admin" link
- [ ] (If `ANTHROPIC_API_KEY` unset) you still get the brief email; review says
  "AI review unavailable"
- [ ] `/onboarding/admin.html` lists the intake; open it → brief, uploaded assets
  (thumbnails), consent record all show
- [ ] Set a **Deposit ($)** and click **"Accept & create Groundwork client"**
- [ ] Verify in the DB / Groundwork admin:
  ```sql
  select id, business_name, care_plan, intake_id from public.gw_clients
    where intake_id is not null order by created_at desc limit 1;
  select label,status from public.gw_integrations
    where client_id = '<that id>';                 -- Website + GBP + your picks
  select project_id, status from public.onb_intakes order by updated_at desc limit 1;
  ```

**Client — sign & pay**
- [ ] The client tab (left open) **unlocks live** — Review shows "✓ Approved!"
  (no refresh)
- [ ] Step 6 (Agreement): the contract renders; type a name + tick agree → **Sign**
  → "Signed" state; (if Resend) a copy email arrives; verify:
  ```sql
  select sign_status, signed_name, agreement_hash is not null from public.onb_intakes
    order by updated_at desc limit 1;              -- signed, name, true
  ```
- [ ] Step 7 (Payment): summary shows the deposit you set + care/mo → **Continue to
  checkout** → Stripe test page → pay with 4242 → returns to "you're all set"
- [ ] Confirm the webhook landed:
  ```sql
  select pay_status, stripe_subscription_id from public.onb_intakes order by updated_at desc limit 1;
  select pay_status, stripe_subscription_id from public.gw_clients  order by updated_at desc limit 1;
  ```
  Both should show `deposit_paid`/`active`, and the gw row **mirrors** it.
- [ ] Stripe test dashboard shows the customer, the one-time deposit **and** the
  subscription (deposit on the first invoice).

**Webhook edge cases**
- [ ] Cancel the test subscription in Stripe → `gw_clients.pay_status` → `canceled`
- [ ] (Optional) Use Stripe's "failed payment" test card on a renewal → `past_due`

---

## Part 3 — Security spot-checks (5 minutes, adversarial)

Run these as the **client** (browser devtools console, signed in):

- [ ] **Pay before approval is blocked** — before accepting, call checkout directly;
  expect **409** "hasn't been approved":
  ```js
  const {data:{session:s}} = await sb.auth.getSession();
  await fetch(ONB_CONFIG.CHECKOUT_FN,{method:'POST',headers:{'Content-Type':'application/json',apikey:ONB_CONFIG.SUPABASE_ANON_KEY,Authorization:'Bearer '+s.access_token},body:JSON.stringify({intake_id:'<your intake>'})}).then(r=>r.status)
  ```
- [ ] **Deposit tamper is blocked** — as the client, try to set your own price;
  expect the value to NOT stick (guard trigger forces it back):
  ```js
  await sb.from('onb_intakes').update({deposit_amount:1}).eq('id','<your intake>');
  (await sb.from('onb_intakes').select('deposit_amount').single()).data   // unchanged
  ```
- [ ] **Lookup needs a real user** — call `onb-lookup` with only the anon key (no
  user token) → expect **401** (not 200/503).
- [ ] **Re-sign is blocked** — call `onb-sign` again on a signed intake → **409**
  "already signed."
- [ ] **No cross-tenant read** — a second test account cannot see the first's
  intake (`select` returns 0 rows).

---

## Part 4 — Go / No-Go (must all pass before live money)

- [ ] Full happy path (Part 2) completed with a real test charge + subscription
- [ ] gw_clients created, integrations seeded, billing mirrored
- [ ] All Part 3 security checks behaved as expected
- [ ] Signature copy + new-brief emails deliver (not spam) — or you've accepted
  Resend isn't set up yet
- [ ] Deposit amounts / care prices reviewed for real numbers
- [ ] You've decided the deposit policy for Full Build / custom (they charge $0
  online by design — you quote them)

---

## Part 5 — Flip to live

- [ ] Swap secrets to **live**: `STRIPE_SECRET_KEY = sk_live_…`
- [ ] Create a **live-mode** Stripe webhook (same URL + events) → new
  `STRIPE_WEBHOOK_SECRET`
- [ ] Do ONE real end-to-end with a small real deposit on your own card; refund it
  in Stripe afterward
- [ ] Watch **Edge Function logs** for the first few real clients (esp. `onb-webhook`
  — a 500 means Stripe will retry; a persistent 500 needs you)

---

## Part 6 — Rollback / kill switch

- **Hide the entry** — remove the "Start your project brief" links in
  `groundwork/portal/index.html` (dashboard + "no setup yet"), push. The wizard
  becomes unreachable without deleting anything.
- **Stop payments only** — unset `STRIPE_SECRET_KEY`; checkout returns "payments
  not configured," the rest of the flow still works.
- **Stop the whole backend** — undeploy the functions; the wizard shows the
  graceful "finishing setup" state.
- Nothing is destructive; drafts and data remain intact through any of the above.

---

## Notes / not-yet-done (track separately)
- No automated tests yet — this checklist is the manual gate.
- No monitoring/alerts on webhook failures (watch logs manually for now).
- Sales tax (Stripe Tax) not enabled; refund/subscription-cancel is Stripe-dashboard.
- Offboarding is covered by **SOP-014 Hooks E/F** (in the LPC repo).
