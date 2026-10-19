// ============================================================
// Lost Pines — lpc-billing (Supabase Edge Function)
//
// The owner's invoices and "Manage billing" on the app's Account screen (016).
//   POST {action: "invoices", client_id}  → {invoices: [...]} (latest 12, no drafts)
//   POST {action: "portal",   client_id}  → {url} Stripe customer portal session
// Only the business's owner (gw_owns_client, checked with THEIR token) gets an
// answer; the Stripe customer id never leaves the server. A business with no
// Stripe customer yet gets {invoices: []} / 404 no_billing.
//
// Deploy with Verify JWT ON. Secret: STRIPE_SECRET_KEY (same as onb-checkout).
// Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Stripe ▸ Settings ▸ Billing ▸ Customer portal must be activated for "portal".
// ============================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const RETURN_URL = "https://lostpinescreative.com/app/billing-done.html";
const T_EXT = 8000;

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://lostpinescreative.com,https://www.lostpinescreative.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const REST = `${SB_URL}/rest/v1`;
const svc = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fetchT(url: string, opts: RequestInit, ms = T_EXT): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}

// Browsers must be on the allow-list; the native app sends no Origin.
function cors(origin: string | null): Record<string, string> | null {
  if (origin && !(ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin))) return null;
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const json = (o: unknown, s: number, c: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...c } });

const stripe = (path: string, init: RequestInit = {}) =>
  fetchT(`https://api.stripe.com/v1/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
  });

// Only Stripe's own pages may be opened from the app.
const stripeUrl = (u: unknown, host: string) => {
  try { const x = new URL(String(u)); return x.protocol === "https:" && x.host === host ? x.href : null; } catch { return null; }
};

export type Invoice = {
  id: string; number: string | null; created: string; due: string | null;
  total: number; paid: number; due_amount: number; currency: string;
  status: "open" | "paid" | "void" | "uncollectible"; what: string; url: string | null;
};

// deno-lint-ignore no-explicit-any
function toInvoice(i: any): Invoice {
  const lines: string[] = (i?.lines?.data ?? []).map((l: { description?: string }) => l?.description ?? "").filter(Boolean);
  return {
    id: String(i.id),
    number: i.number ?? null,
    created: new Date(Number(i.created) * 1000).toISOString(),
    due: i.due_date ? new Date(Number(i.due_date) * 1000).toISOString() : null,
    total: Number(i.total ?? 0) / 100,
    paid: Number(i.amount_paid ?? 0) / 100,
    due_amount: Number(i.amount_remaining ?? 0) / 100,
    currency: String(i.currency ?? "usd"),
    status: i.status,
    what: (i.description || lines[0] || "Invoice").slice(0, 120) + (lines.length > 1 ? ` + ${lines.length - 1} more` : ""),
    url: stripeUrl(i.hosted_invoice_url, "invoice.stripe.com"),
  };
}

Deno.serve(async (req) => {
  const c = cors(req.headers.get("origin"));
  if (!c) return json({ error: "origin not allowed" }, 403);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, c);

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "not signed in" }, 401, c);
    const body = await req.json().catch(() => null);
    const action = body?.action, clientId = String(body?.client_id ?? "");
    if (!["invoices", "portal"].includes(action) || !UUID.test(clientId)) return json({ error: "bad request" }, 400, c);

    // Ownership is checked as the caller (their JWT → auth.uid()), not as the service role.
    const own = await fetchT(`${REST}/rpc/gw_owns_client`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_client: clientId }),
    });
    if (own.status === 401 || own.status === 403) return json({ error: "not signed in" }, 401, c);
    if (!own.ok) throw new Error(`owns ${own.status}`);
    if ((await own.json()) !== true) return json({ error: "not found" }, 404, c);

    const cr = await fetchT(`${REST}/gw_clients?select=stripe_customer_id&id=eq.${clientId}`, { headers: svc });
    if (!cr.ok) throw new Error(`client ${cr.status}`);
    const customer = ((await cr.json()) as { stripe_customer_id: string | null }[])[0]?.stripe_customer_id ?? null;

    if (!customer || !STRIPE_KEY) {
      return action === "invoices" ? json({ invoices: [] }, 200, c) : json({ error: "no billing yet", code: "no_billing" }, 404, c);
    }

    if (action === "invoices") {
      const r = await stripe(`invoices?customer=${encodeURIComponent(customer)}&limit=12`);
      if (!r.ok) { console.error("stripe invoices", r.status); throw new Error("stripe"); }
      // deno-lint-ignore no-explicit-any
      const data: any[] = (await r.json())?.data ?? [];
      return json({ invoices: data.filter((i) => i?.status && i.status !== "draft").map(toInvoice) }, 200, c);
    }

    const r = await stripe("billing_portal/sessions", {
      method: "POST",
      body: new URLSearchParams({ customer, return_url: RETURN_URL }).toString(),
    });
    if (!r.ok) {
      console.error("stripe portal", r.status);
      return json({ error: "billing page unavailable", code: "portal_off" }, 502, c);
    }
    const url = stripeUrl((await r.json())?.url, "billing.stripe.com");
    if (!url) throw new Error("portal url");
    return json({ url }, 200, c);
  } catch (e) {
    console.error("lpc-billing error", String(e));
    return json({ error: "couldn't load billing — please try again", code: "retry" }, 503, c);
  }
});
