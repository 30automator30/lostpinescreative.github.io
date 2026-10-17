// Behaviour tests for lpc-request-notify — fakes Supabase Auth, PostgREST and Resend.
// Run: deno test -A groundwork/_backend/lpc-request-notify/index.test.ts
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "https://proj.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "srk");
Deno.env.set("RESEND_API_KEY", "re_test");

type Row = Record<string, unknown>;
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const STRANGER = "aaaaaaaa-0000-4000-8000-000000000002";
const REQ = "bbbbbbbb-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const sessions: Record<string, { id: string; email: string }> = {
  "jwt-owner": { id: OWNER, email: "owner@biz.com" },
  "jwt-stranger": { id: STRANGER, email: "x@y.com" },
};
let requests: Row[] = [];
let emails: Row[] = [];
let resendFails = false;
let authDown = false;

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
function matches(row: Row, p: URLSearchParams): boolean {
  for (const [k, v] of p) {
    if (k === "select") continue;
    if (v.startsWith("eq.")) { if (String(row[k]) !== v.slice(3)) return false; }
    else if (v === "is.null") { if (row[k] != null) return false; }
    else if (v.startsWith("gte.")) { if (!(row[k] != null && String(row[k]) >= v.slice(4))) return false; }
    else throw new Error(`fake: unsupported ${k}=${v}`);
  }
  return true;
}
function fake(input: string | URL | Request, init?: RequestInit): Response {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const h = new Headers(init?.headers);
  if (url.host === "api.resend.com") {
    if (resendFails) return new Response("nope", { status: 500 });
    emails.push(JSON.parse(String(init!.body)));
    return ok({ id: "em_1" });
  }
  if (url.pathname === "/auth/v1/user") {
    if (authDown) return new Response("down", { status: 503 });
    const u = sessions[(h.get("Authorization") ?? "").replace(/^Bearer /, "")];
    return u ? ok(u) : new Response("{}", { status: 401 });
  }
  const table = url.pathname.replace("/rest/v1/", "");
  const p = url.searchParams;
  if (table === "lpc_requests") {
    const hit = requests.filter((r) => matches(r, p));
    if (init?.method === "PATCH") { hit.forEach((r) => Object.assign(r, JSON.parse(String(init.body)))); return ok(hit); }
    return ok(hit);
  }
  if (table === "gw_clients") return ok(p.get("id") === `eq.${CLIENT}` ? [{ business_name: "Bastrop Plumbing" }] : []);
  throw new Error(`unexpected fetch ${url}`);
}
globalThis.fetch = ((i: string | URL | Request, init?: RequestInit) =>
  Promise.resolve().then(() => fake(i, init))) as typeof fetch;

let handler!: (r: Request) => Promise<Response>;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: typeof handler) => { handler = h; };
await import("./index.ts");

const FN = "https://proj.supabase.co/functions/v1/lpc-request-notify";
const call = (jwt: string | null, body: unknown = { request_id: REQ }, origin?: string) =>
  handler(new Request(FN, {
    method: "POST",
    headers: { "content-type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  }));
const reset = () => {
  requests = [{ id: REQ, user_id: OWNER, service: "groundwork", kind: "change", client_id: CLIENT,
    body: "Please change my <b>greeting</b>", notified_at: null }];
  emails = []; resendFails = false; authDown = false;
};

Deno.test("owner's request -> one email to the studio with business, reply-to, escaped body", async () => {
  reset();
  const r = await call("jwt-owner");
  assertEquals(r.status, 200);
  assertEquals((await r.json()).sent, 1);
  assertEquals(emails.length, 1);
  assertEquals(emails[0].to, ["ddesmit@lostpinescreative.com"]);
  assertEquals(emails[0].reply_to, ["owner@biz.com"]);
  assertMatch(String(emails[0].subject), /Change to my setup — Groundwork/);
  assertMatch(String(emails[0].html), /Bastrop Plumbing/);
  assertMatch(String(emails[0].html), /&lt;b&gt;greeting&lt;\/b&gt;/);
  assert(requests[0].notified_at);
});

Deno.test("second call (retry / double tap) sends nothing more", async () => {
  reset();
  await call("jwt-owner");
  const r = await call("jwt-owner");
  assertEquals((await r.json()).already, true);
  assertEquals(emails.length, 1);
});

Deno.test("someone else's request -> 404; no session -> 401; bad id -> 400", async () => {
  reset();
  assertEquals((await call("jwt-stranger")).status, 404);
  assertEquals((await call("jwt-bogus")).status, 401);
  assertEquals((await call(null)).status, 401);
  assertEquals((await call("jwt-owner", { request_id: "nope" })).status, 400);
  assertEquals(emails.length, 0);
});

Deno.test("email fails -> 502 and the request can be retried later", async () => {
  reset();
  resendFails = true;
  assertEquals((await call("jwt-owner")).status, 502);
  assertEquals(requests[0].notified_at, null);
  resendFails = false;
  assertEquals((await (await call("jwt-owner")).json()).sent, 1);
});

Deno.test("more than 10 emails a day from one customer -> saved, not emailed", async () => {
  reset();
  const now = new Date().toISOString();
  for (let i = 0; i < 10; i++) requests.push({ id: `old-${i}`, user_id: OWNER, notified_at: now });
  const r = await call("jwt-owner");
  assertEquals((await r.json()).capped, true);
  assertEquals(emails.length, 0);
});

Deno.test("native app (no Origin) is allowed; a foreign website is not; auth down -> 503", async () => {
  reset();
  assertEquals((await call("jwt-owner", { request_id: REQ }, "https://evil.example")).status, 403);
  assertEquals((await call("jwt-owner", { request_id: REQ }, "https://lostpinescreative.com")).status, 200);
  reset();
  authDown = true;
  assertEquals((await call("jwt-owner")).status, 503);
});
