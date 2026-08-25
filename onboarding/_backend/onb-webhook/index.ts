// ============================================================
// Onboarding — onb-webhook (Supabase Edge Function)
//
// Receives Stripe webhook events and updates the intake's payment state. This
// is the ONLY authority for pay_status — the browser never sets it.
//
//   checkout.session.completed  → deposit_paid (payment) / active (subscription)
//   invoice.paid                → active (recurring care plan renewed)
//   invoice.payment_failed      → past_due
//   customer.subscription.deleted → canceled
//
// Deploy with Verify JWT OFF (Stripe calls it unauthenticated); the Stripe
// signature is verified manually below instead.
// Secrets: STRIPE_WEBHOOK_SECRET. Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// ============================================================
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WH_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

const REST = `${SB_URL}/rest/v1`;
const svc = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Verify Stripe's `t=…,v1=…[,v1=…]` signature header against the raw body.
// Stripe can emit MULTIPLE v1 signatures during a secret rotation — accept if
// ANY matches, so rotation doesn't reject legitimate events.
async function verify(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  let t = "";
  const v1s: string[] = [];
  for (const part of sigHeader.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1s.push(v);
  }
  if (!t || !v1s.length) return false;
  // tolerance: reject events older or more-future than 5 minutes.
  const age = Math.floor(Date.now() / 1000) - Number(t);
  if (!Number.isFinite(age) || age > 300 || age < -300) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return v1s.some((v1) => ctEq(expected, v1));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!WH_SECRET) return new Response("not configured", { status: 500 });

  const sig = req.headers.get("stripe-signature") ?? "";
  const raw = await req.text();
  if (!(await verify(raw, sig, WH_SECRET))) return new Response("bad signature", { status: 400 });

  let evt: Record<string, unknown>;
  try { evt = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  const type = String(evt.type);
  const obj = (evt.data as Record<string, unknown>)?.object as Record<string, unknown> ?? {};

  try {
    let ok = true;
    if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
      const intakeId = metaIntake(obj) || String(obj.client_reference_id ?? "");
      const mode = String(obj.mode ?? "");
      // A one-time (payment-mode) session can complete while still `unpaid` for
      // delayed/async payment methods — only mark paid once actually paid. The
      // later `checkout.session.async_payment_succeeded` (handled by this same
      // branch, where payment_status is `paid`) confirms it.
      if (mode === "payment" && obj.payment_status && obj.payment_status !== "paid") {
        return ack();
      }
      const patch: Record<string, unknown> = {
        pay_status: mode === "subscription" ? "active" : "deposit_paid",
      };
      if (obj.subscription) patch.stripe_subscription_id = String(obj.subscription);
      if (obj.customer) patch.stripe_customer_id = String(obj.customer);
      ok = await patchIntake(intakeId, obj.customer, patch);
      if (ok) ok = await syncLinkedClient(intakeId, obj.customer, patch);
      if (ok) await logEvent(intakeId, mode === "subscription" ? "subscription_active" : "deposit_paid", { session: obj.id });
    } else if (type === "invoice.paid") {
      const intakeId = metaIntake(obj);
      const patch = { pay_status: "active" };
      ok = await patchIntake(intakeId, obj.customer, patch);
      if (ok) ok = await syncLinkedClient(intakeId, obj.customer, patch);
      if (ok) await logEvent(intakeId, "invoice_paid", { invoice: obj.id });
    } else if (type === "invoice.payment_failed") {
      const intakeId = metaIntake(obj);
      const patch = { pay_status: "past_due" };
      ok = await patchIntake(intakeId, obj.customer, patch);
      if (ok) ok = await syncLinkedClient(intakeId, obj.customer, patch);
      if (ok) await logEvent(intakeId, "payment_failed", { invoice: obj.id });
    } else if (type === "customer.subscription.deleted") {
      const intakeId = metaIntake(obj);
      const patch = { pay_status: "canceled" };
      ok = await patchIntake(intakeId, obj.customer, patch);
      if (ok) ok = await syncLinkedClient(intakeId, obj.customer, patch);
      if (ok) await logEvent(intakeId, "subscription_canceled", { subscription: obj.id });
    }
    // A transient write failure must NOT be acknowledged — return 500 so Stripe
    // retries, rather than silently losing a payment state change.
    if (!ok) return new Response("db write failed", { status: 500 });
  } catch (e) {
    console.error("webhook handling error", type, e);
    return new Response("handler error", { status: 500 }); // let Stripe retry
  }
  return ack();
});

function ack() {
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}
function metaIntake(obj: Record<string, unknown>): string {
  const m = (obj.metadata as Record<string, unknown>) || {};
  return String(m.intake_id ?? "");
}
// Update by intake id when we have it, else fall back to the Stripe customer id.
// Returns true on a successful write (or a deliberate no-op), false on failure.
async function patchIntake(intakeId: string, customer: unknown, patch: Record<string, unknown>): Promise<boolean> {
  let url = "";
  if (intakeId) url = `${REST}/onb_intakes?id=eq.${encodeURIComponent(intakeId)}`;
  else if (customer) url = `${REST}/onb_intakes?stripe_customer_id=eq.${encodeURIComponent(String(customer))}`;
  else return true; // nothing to target — not a failure
  try {
    const r = await fetch(url, { method: "PATCH", headers: { ...svc, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
    if (!r.ok) { console.error("patchIntake non-2xx", r.status, await r.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.error("patchIntake threw", e); return false; }
}
// Mirror billing state onto the linked in-service Groundwork client (if the
// intake has been provisioned to a gw_clients record), so recurring-revenue
// status is live where the studio manages the client. Returns false on a real
// failure so the caller can 500 and let Stripe retry (patchIntake is idempotent,
// so re-processing the event is safe); returns true on success or a legitimate
// no-op (no linked client yet).
async function syncLinkedClient(intakeId: string, customer: unknown, patch: Record<string, unknown>): Promise<boolean> {
  try {
    const url = intakeId
      ? `${REST}/onb_intakes?id=eq.${encodeURIComponent(intakeId)}&select=project_id`
      : customer
        ? `${REST}/onb_intakes?stripe_customer_id=eq.${encodeURIComponent(String(customer))}&select=project_id`
        : "";
    if (!url) return true;
    const r = await fetch(url, { headers: svc });
    if (!r.ok) { console.error("syncLinkedClient lookup non-2xx", r.status); return false; }
    const rows = await r.json();
    const pid = Array.isArray(rows) && rows[0] ? rows[0].project_id : null;
    if (!pid) return true; // not provisioned to an in-service client yet
    // gw_clients shares the pay_status / stripe_* column names, so the same
    // patch applies. (status — the lifecycle field — is left to the studio.)
    const pr = await fetch(`${REST}/gw_clients?id=eq.${encodeURIComponent(String(pid))}`, {
      method: "PATCH", headers: { ...svc, Prefer: "return=minimal" }, body: JSON.stringify(patch),
    });
    if (!pr.ok) { console.error("syncLinkedClient gw patch non-2xx", pr.status, await pr.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.error("syncLinkedClient threw", e); return false; }
}
async function logEvent(intakeId: string, kind: string, detail: Record<string, unknown>) {
  if (!intakeId) return;
  await fetch(`${REST}/onb_events`, {
    method: "POST", headers: { ...svc, Prefer: "return=minimal" },
    body: JSON.stringify({ intake_id: intakeId, kind, detail }),
  }).catch(() => {});
}
