// Behaviour tests for lpc-billing — fakes PostgREST and Stripe.
// Run: deno test -A groundwork/_backend/lpc-billing/index.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "https://proj.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "srk");
Deno.env.set("STRIPE_SECRET_KEY", "sk_test_1");

const MINE = "aaaaaaaa-0000-4000-8000-000000000001";
const NOBILL = "aaaaaaaa-0000-4000-8000-000000000002";
const THEIRS = "aaaaaaaa-0000-4000-8000-000000000003";
const owns: Record<string, string[]> = { "jwt-amy": [MINE, NOBILL] };
const customers: Record<string, string | null> = { [MINE]: "cus_1", [NOBILL]: null, [THEIRS]: "cus_2" };
let stripeCalls: string[] = [];
let portalOn = true;

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const auth = new Headers(init?.headers).get("Authorization") ?? "";
  if (url.pathname === "/rest/v1/rpc/gw_owns_client") {
    const jwt = auth.replace(/^Bearer /, "");
    if (!(jwt in owns)) return new Response("{}", { status: 401 });
    return ok(owns[jwt].includes(JSON.parse(String(init!.body)).p_client));
  }
  if (url.pathname === "/rest/v1/gw_clients") {
    assertEquals(auth, "Bearer srk");
    const id = url.searchParams.get("id")!.replace(/^eq\./, "");
    return ok([{ stripe_customer_id: customers[id] }]);
  }
  if (url.host === "api.stripe.com") {
    assertEquals(auth, "Bearer sk_test_1");
    stripeCalls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/v1/invoices") {
      assertEquals(url.searchParams.get("customer"), "cus_1");
      return ok({ data: [
        { id: "in_1", number: "LPC-0001", created: 1760000000, status: "paid", total: 175000, amount_paid: 175000,
          amount_remaining: 0, currency: "usd", lines: { data: [{ description: "Project deposit (applied to total)" }] },
          hosted_invoice_url: "https://invoice.stripe.com/i/acct_1/abc" },
        { id: "in_2", number: "LPC-0002", created: 1761000000, due_date: 1762000000, status: "open", total: 175000,
          amount_paid: 0, amount_remaining: 175000, currency: "usd", description: "Website balance",
          hosted_invoice_url: "https://evil.example/pay" },
        { id: "in_3", status: "draft", total: 100, created: 1761000000 },
      ] });
    }
    if (url.pathname === "/v1/billing_portal/sessions") {
      if (!portalOn) return new Response('{"error":{}}', { status: 400 });
      const f = new URLSearchParams(String(init!.body));
      assertEquals(f.get("customer"), "cus_1");
      return ok({ url: "https://billing.stripe.com/p/session/xyz" });
    }
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

let handler!: (r: Request) => Promise<Response>;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: typeof handler) => { handler = h; };
await import("./index.ts");

const call = (body: unknown, jwt = "jwt-amy", origin?: string) =>
  handler(new Request("https://proj.supabase.co/functions/v1/lpc-billing", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  }));

Deno.test("invoices: the owner's latest, no drafts, only Stripe's own pay links", async () => {
  stripeCalls = [];
  const r = await call({ action: "invoices", client_id: MINE });
  assertEquals(r.status, 200);
  const { invoices } = await r.json();
  assertEquals(invoices.length, 2);
  assertEquals(invoices[0].total, 1750);
  assertEquals(invoices[0].what, "Project deposit (applied to total)");
  assertEquals(invoices[0].url, "https://invoice.stripe.com/i/acct_1/abc");
  assertEquals(invoices[1].status, "open");
  assertEquals(invoices[1].due_amount, 1750);
  assertEquals(invoices[1].url, null, "a non-Stripe link is dropped");
  assert(!JSON.stringify(invoices).includes("cus_1"), "customer id never returned");
});

Deno.test("someone else's business: 404 and Stripe is never called", async () => {
  stripeCalls = [];
  assertEquals((await call({ action: "invoices", client_id: THEIRS })).status, 404);
  assertEquals((await call({ action: "portal", client_id: THEIRS })).status, 404);
  assertEquals(stripeCalls, []);
});

Deno.test("not signed in / bad input / disallowed browser origin", async () => {
  assertEquals((await call({ action: "invoices", client_id: MINE }, "nope")).status, 401);
  assertEquals((await call({ action: "refund", client_id: MINE })).status, 400);
  assertEquals((await call({ action: "invoices", client_id: "x" })).status, 400);
  assertEquals((await call({ action: "invoices", client_id: MINE }, "jwt-amy", "https://evil.example")).status, 403);
});

Deno.test("no Stripe customer yet: empty invoices, portal says no_billing", async () => {
  stripeCalls = [];
  assertEquals((await (await call({ action: "invoices", client_id: NOBILL })).json()).invoices, []);
  const p = await call({ action: "portal", client_id: NOBILL });
  assertEquals(p.status, 404);
  assertEquals((await p.json()).code, "no_billing");
  assertEquals(stripeCalls, []);
});

Deno.test("portal: a Stripe billing link; portal not activated in Stripe → portal_off", async () => {
  portalOn = true;
  const r = await call({ action: "portal", client_id: MINE });
  assertEquals((await r.json()).url, "https://billing.stripe.com/p/session/xyz");
  portalOn = false;
  const off = await call({ action: "portal", client_id: MINE });
  assertEquals(off.status, 502);
  assertEquals((await off.json()).code, "portal_off");
});
