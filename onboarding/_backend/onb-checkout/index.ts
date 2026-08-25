// ============================================================
// Onboarding — onb-checkout (Supabase Edge Function)
//
// Creates a Stripe Checkout Session for an onboarding intake: a one-time
// project DEPOSIT and (optionally) a recurring CARE-PLAN subscription, in a
// single hosted checkout. Returns { url } for the browser to redirect to — no
// Stripe.js ships to the client, and the card never touches our servers.
//
// Amounts are SERVER-AUTHORITATIVE (the maps below / an admin-set
// deposit_amount) so a client can't tamper with the price.
//
// Deploy with Verify JWT ON. Requires the intake to be signed first.
// Secrets: STRIPE_SECRET_KEY. Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// ============================================================
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://lostpinescreative.com,https://www.lostpinescreative.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const REST = `${SB_URL}/rest/v1`;
const AUTH = `${SB_URL}/auth/v1`;
const svc = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- price policy (edit here or override per-intake via deposit_amount) ---
// Booking deposit by package, in whole USD = 50% of each tier's FLOOR price
// (Starter $750, Foundation $1,500, Growth $3,500). It's a deposit to start;
// the balance is billed on delivery/launch. The remaining balance and any
// amount above the floor are settled against the real quote.
//
// Full Build and "not sure yet" are SCOPED from a discovery workshop, so they
// are never auto-charged here (→ 0 = the studio sends a quote and sets the real
// deposit on the intake). An admin-set onb_intakes.deposit_amount ALWAYS wins,
// so once you quote a client the exact figure, that is what they pay.
const DEPOSIT_BY_PACKAGE: Record<string, number> = {
  starter: 375, foundation: 750, growth: 1750, full_build: 0, custom: 0,
};
// Care plan monthly USD. Annual = 10× monthly (2 months free — an incentive, not
// stated in the manuals; adjust or set equal to 12× to disable). partner = custom.
const CARE_MONTHLY: Record<string, number> = { essential: 99, growth: 300 };

// Sentinel for a disallowed origin — NOT the literal "null" (a browser treats
// ACAO:"null" as a match for an `Origin: null` sandboxed/data: caller).
const DENY_ORIGIN = "https://denied.invalid";
function cors(origin: string | null) {
  const ok = origin && (ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : DENY_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Max-Age": "86400", Vary: "Origin",
  };
}
const json = (o: unknown, s: number, c: Record<string, string>) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...c } });

// Stripe REST helper — form-encoded, supports nested keys via dotted paths.
// An optional idempotency key makes retries (double-click, network retry) return
// the same object instead of creating duplicate customers/sessions/charges.
async function stripe(path: string, params: Record<string, string>, idempotencyKey?: string) {
  const bodyPairs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { method: "POST", headers, body: bodyPairs.join("&") });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Stripe error");
  return data;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const c = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, c);
  if (c["Access-Control-Allow-Origin"] === DENY_ORIGIN) return json({ error: "origin not allowed" }, 403, c);
  if (!STRIPE_KEY) return json({ error: "payments not configured" }, 500, c);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "not signed in" }, 401, c);
  const uRes = await fetch(`${AUTH}/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!uRes.ok) return json({ error: "not signed in" }, 401, c);
  const caller = await uRes.json();
  const callerId: string = caller?.id;
  if (!callerId) return json({ error: "not signed in" }, 401, c);

  const body = await req.json().catch(() => null);
  const intakeId = String(body?.intake_id ?? "").trim();
  const returnUrl = String(body?.return_url ?? "").trim();
  if (!UUID_RE.test(intakeId)) return json({ error: "invalid intake" }, 400, c);

  const rows = await getRows(`${REST}/onb_intakes?id=eq.${intakeId}&select=*`);
  if (!rows.length) return json({ error: "intake not found" }, 404, c);
  const it = rows[0] as Record<string, unknown>;
  if (it.owner_id !== callerId) {
    const adm = await getRows(`${REST}/dd_profiles?id=eq.${callerId}&is_admin=eq.true&select=id`);
    if (!adm.length) return json({ error: "not allowed" }, 403, c);
  }
  // Quote-first gate, enforced server-side: the studio must review & accept the
  // brief (and set the real deposit) before any money moves. Do not rely on the
  // browser's UI gate alone.
  if (it.status !== "accepted") {
    return json({ error: "This brief hasn't been approved yet — the studio will send your quote first." }, 409, c);
  }
  if (it.sign_status !== "signed") return json({ error: "please sign the agreement first" }, 400, c);

  // resolve server-authoritative amounts
  const pkg = String(it.package ?? "");
  const adminDeposit = it.deposit_amount != null ? Number(it.deposit_amount) : null;
  const depositUsd = adminDeposit && adminDeposit > 0 ? adminDeposit : (DEPOSIT_BY_PACKAGE[pkg] ?? 0);
  const carePlan = String(it.care_plan ?? "");
  const careMonthly = CARE_MONTHLY[carePlan] ?? 0;
  const annual = String(it.billing_cycle ?? "monthly") === "annual";
  const email = String(it.contact_email ?? caller?.email ?? "");
  const bizName = String(it.business_name ?? "your project");

  if (depositUsd <= 0 && careMonthly <= 0) {
    return json({ error: "Nothing to charge online yet — the studio will send you a quote. Email us to arrange payment." }, 400, c);
  }

  // ensure a Stripe customer
  let customerId = String(it.stripe_customer_id ?? "");
  if (!customerId) {
    const cust = await stripe("customers", {
      email, name: bizName, "metadata[intake_id]": intakeId, "metadata[user_id]": callerId,
    }, `onb-customer:${intakeId}`);
    customerId = cust.id;
    await fetch(`${REST}/onb_intakes?id=eq.${intakeId}`, {
      method: "PATCH", headers: { ...svc, Prefer: "return=minimal" },
      body: JSON.stringify({ stripe_customer_id: customerId }),
    });
  }

  // build the checkout session
  const params: Record<string, string> = {
    customer: customerId,
    success_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}paid=1`,
    cancel_url: returnUrl,
    "metadata[intake_id]": intakeId,
    "client_reference_id": intakeId,
    allow_promotion_codes: "true",
  };

  let li = 0;
  const subscription = careMonthly > 0;
  if (subscription) {
    // recurring care plan line item
    params.mode = "subscription";
    params["subscription_data[metadata][intake_id]"] = intakeId;
    const interval = annual ? "year" : "month";
    const amount = annual ? careMonthly * 10 : careMonthly;
    params[`line_items[${li}][price_data][currency]`] = "usd";
    params[`line_items[${li}][price_data][product_data][name]`] = `${cap(carePlan)} care plan (${interval}ly)`;
    params[`line_items[${li}][price_data][recurring][interval]`] = interval;
    params[`line_items[${li}][price_data][unit_amount]`] = String(Math.round(amount * 100));
    params[`line_items[${li}][quantity]`] = "1";
    li++;
    if (depositUsd > 0) {
      // one-time deposit — added to the first subscription invoice
      params[`line_items[${li}][price_data][currency]`] = "usd";
      params[`line_items[${li}][price_data][product_data][name]`] = "Project deposit (applied to total)";
      params[`line_items[${li}][price_data][unit_amount]`] = String(Math.round(depositUsd * 100));
      params[`line_items[${li}][quantity]`] = "1";
      li++;
    }
  } else {
    // deposit only — one-time payment
    params.mode = "payment";
    params["payment_intent_data[metadata][intake_id]"] = intakeId;
    params[`line_items[${li}][price_data][currency]`] = "usd";
    params[`line_items[${li}][price_data][product_data][name]`] = "Project deposit (applied to total)";
    params[`line_items[${li}][price_data][unit_amount]`] = String(Math.round(depositUsd * 100));
    params[`line_items[${li}][quantity]`] = "1";
    li++;
  }

  let session;
  try {
    // Key includes the priced inputs so a re-quote (new deposit/plan) yields a
    // fresh session, while a plain double-click reuses the same one.
    const idem = `onb-checkout:${intakeId}:${depositUsd}:${carePlan}:${annual ? "y" : "m"}`;
    session = await stripe("checkout/sessions", params, idem);
  } catch (e) {
    console.error("stripe checkout failed", e);
    return json({ error: (e as Error).message || "Couldn't start checkout." }, 502, c);
  }

  await fetch(`${REST}/onb_intakes?id=eq.${intakeId}`, {
    method: "PATCH", headers: { ...svc, Prefer: "return=minimal" },
    body: JSON.stringify({ stripe_checkout_session: session.id }),
  });

  return json({ url: session.url }, 200, c);
});

function cap(s: string) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
async function getRows(url: string): Promise<Array<Record<string, unknown>>> {
  try {
    const r = await fetch(url, { headers: svc });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}
