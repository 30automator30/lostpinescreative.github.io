// Behaviour tests for gw-device — fakes PostgREST.
// Run: deno test -A groundwork/_backend/gw-device/index.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "https://proj.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "srk");
Deno.env.set("SUPABASE_ANON_KEY", "anon");

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------- fake state ----------
type Row = Record<string, unknown>;
const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_CLIENT = "22222222-2222-4222-8222-222222222222";
// Supabase sessions: JWT -> user. The fake applies gw_clients RLS for user JWTs.
const OWNER_JWT = "jwt-owner-xxxxxxxxxxxxxxxxxxxx";
const STRANGER_JWT = "jwt-stranger-xxxxxxxxxxxxxxxxx";
const ADMIN_JWT = "jwt-admin-xxxxxxxxxxxxxxxxxxxxx";
const sessions: Record<string, { id: string; admin: boolean }> = {
  [OWNER_JWT]: { id: "u-owner", admin: false },
  [STRANGER_JWT]: { id: "u-stranger", admin: false },
  [ADMIN_JWT]: { id: "u-admin", admin: true },
};
let clients: Row[] = [];
let settings: Row[] = [];
let lines: Row[] = [];
let devices: Row[] = [];
let messages: Row[] = [];
let failDb = false;

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...headers } });

// Minimal PostgREST filter: eq / gt / gte / is.null on top-level columns.
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [k, v] of params) {
    if (["select", "on_conflict", "limit"].includes(k)) continue;
    const val = row[k];
    if (v.startsWith("eq.")) { if (String(val) !== v.slice(3)) return false; }
    else if (v === "is.null") { if (val != null) return false; }
    else if (v.startsWith("gt.")) { if (!(String(val) > v.slice(3))) return false; }
    else if (v.startsWith("gte.")) { if (!(String(val) >= v.slice(3))) return false; }
    else throw new Error(`fake: unsupported filter ${k}=${v}`);
  }
  return true;
}

function fakeFetch(input: string | URL | Request, init?: RequestInit): Response {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? "GET";
  const prefer = new Headers(init?.headers).get("Prefer") ?? "";
  if (url.host !== "proj.supabase.co") throw new Error(`unexpected fetch ${url}`);
  if (failDb) return new Response("down", { status: 503 });
  const table = url.pathname.replace("/rest/v1/", "");
  const p = url.searchParams;
  const body = init?.body ? JSON.parse(String(init.body)) : null;

  const bearer = (new Headers(init?.headers).get("Authorization") ?? "").replace(/^Bearer /, "");
  if (url.pathname === "/auth/v1/user") {
    const u = sessions[bearer];
    return u ? ok({ id: u.id }) : new Response("{}", { status: 401 });
  }
  if (table === "dd_profiles") {
    return ok(Object.values(sessions).filter((u) => `eq.${u.id}` === p.get("id")).map((u) => ({ is_admin: u.admin })));
  }
  if (table === "gw_clients") {
    const u = sessions[bearer]; // user JWT -> RLS: owner or admin only
    assert(u, "gw_clients must be read with the user's JWT, not the service role");
    return ok(clients.filter((c) => matches(c, p) && (u.admin || c.owner_id === u.id))
      .map((c) => ({ id: c.id, status: c.status })));
  }
  if (table === "gw_devices") {
    if (method === "POST") {
      const row = { id: `dev-${devices.length + 1}`, revoked_at: null, ...body };
      devices.push(row);
      return ok([{ id: row.id }]);
    }
    if (method === "PATCH") {
      devices.filter((r) => matches(r, p)).forEach((r) => Object.assign(r, body));
      return ok([]);
    }
    if (prefer.includes("count=exact")) {
      return ok([], { "content-range": `0-0/${devices.filter((r) => matches(r, p)).length}` });
    }
    const rows = devices.filter((r) => matches(r, p)).map((d) => {
      const c = clients.find((x) => x.id === d.client_id);
      return { ...d, client: c && { ...c, settings: settings.filter((s) => s.client_id === c.id),
        line: lines.find((l) => l.client_id === c.id) ?? null } };
    });
    return ok(rows);
  }
  if (table === "gw_messages" && method === "POST") {
    assertEquals(p.get("on_conflict"), "external_id");
    assert(prefer.includes("ignore-duplicates"));
    for (const row of body as Row[]) {
      if (!messages.some((m) => m.external_id === row.external_id)) messages.push({ status: "new", ...row });
    }
    return ok([]);
  }
  throw new Error(`fake: unhandled ${method} ${url}`);
}
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
  Promise.resolve().then(() => fakeFetch(input, init))) as typeof fetch;

// Capture the handler instead of serving.
let handler!: (r: Request) => Promise<Response>;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: typeof handler) => { handler = h; };
await import("./index.ts");

const FN = "https://proj.supabase.co/functions/v1/gw-device";
const req = (path: string, opts: { method?: string; body?: unknown; token?: string } = {}) =>
  handler(new Request(`${FN}/${path}`, {
    method: opts.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }));

const reset = () => {
  clients = [
    { id: CLIENT, owner_id: "u-owner", business_name: "DeSmit Designs", status: "active" },
    { id: OTHER_CLIENT, owner_id: "u-stranger", business_name: "Someone Else", status: "active" },
  ];
  settings = [{ client_id: CLIENT, textback_message: "Sorry we missed you! Text us what you need." }];
  lines = []; devices = []; messages = []; failDb = false;
};
const register = (jwt: string | null, body: unknown = { client_id: CLIENT, label: "Pixel 8", app_version: "1.0.0" }) =>
  handler(new Request(`${FN}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(body),
  }));
const pair = async () => {
  const r = await register(OWNER_JWT);
  assertEquals(r.status, 200);
  return await r.json() as { device_id: string; token: string };
};

// ---------- register ----------
Deno.test("register: signed-in owner -> token; only its hash is stored, with who registered it", async () => {
  reset();
  const { device_id, token } = await pair();
  assert(device_id && token.length >= 40);
  assertEquals(devices.length, 1);
  assertEquals(devices[0].token_hash, await sha256(token));
  assertEquals(devices[0].client_id, CLIENT);
  assertEquals(devices[0].registered_by, "u-owner");
  assertEquals(devices[0].label, "Pixel 8");
  assert(!JSON.stringify(devices).includes(token));
});

Deno.test("register: someone else's business, no session or a bad session -> refused", async () => {
  reset();
  const r = await register(STRANGER_JWT);
  assertEquals(r.status, 403);
  assertEquals((await r.json()).code, "not_owner");
  assertEquals((await register("jwt-expired-xxxxxxxxxxxxxxxxxx")).status, 401);
  assertEquals((await register(null)).status, 401);
  assertEquals((await register(OWNER_JWT, { client_id: "c-1" })).status, 400);
  assertEquals(devices.length, 0);
});

Deno.test("register: admin accounts are refused even though they can see every client", async () => {
  reset();
  const r = await register(ADMIN_JWT);
  assertEquals(r.status, 403);
  assertEquals((await r.json()).code, "admin_account");
  assertEquals(devices.length, 0);
});

Deno.test("register: cancelled client -> 409; paused client may register", async () => {
  reset();
  clients[0].status = "cancelled";
  const r = await register(OWNER_JWT);
  assertEquals(r.status, 409);
  assertEquals((await r.json()).code, "client_cancelled");
  clients[0].status = "paused";
  assertEquals((await register(OWNER_JWT)).status, 200);
});

Deno.test("register: at most 5 active phones per business; revoked ones don't count", async () => {
  reset();
  for (let i = 0; i < 5; i++) await pair();
  assertEquals((await register(OWNER_JWT)).status, 409);
  devices[0].revoked_at = new Date().toISOString();
  assertEquals((await register(OWNER_JWT)).status, 200);
});

Deno.test("register: backend down -> 503 (the app retries; nothing half-registered)", async () => {
  reset();
  failDb = true;
  assertEquals((await register(OWNER_JWT)).status, 503);
  failDb = false;
  assertEquals(devices.length, 0);
});

// ---------- config ----------
Deno.test("config: returns the client's text-back message and records last seen", async () => {
  reset();
  const { token } = await pair();
  const r = await handler(new Request(`${FN}/config`, {
    headers: { authorization: `Bearer ${token}`, "x-app-version": "1.0.1" },
  }));
  assertEquals(r.status, 200);
  const cfg = await r.json();
  assertEquals(cfg.business_name, "DeSmit Designs");
  assertEquals(cfg.textback_message, "Sorry we missed you! Text us what you need.");
  assertEquals(cfg.rules.enabled, true);
  assert(devices[0].last_seen_at);
  assertEquals(devices[0].app_version, "1.0.1");
});

Deno.test("config: no message set -> a default naming the business", async () => {
  reset();
  settings = [];
  const { token } = await pair();
  const cfg = await (await req("config", { method: "GET", token })).json();
  assert(String(cfg.textback_message).includes("DeSmit Designs"));
});

Deno.test("config: revoked device, unknown token, or no token -> 401 (D9)", async () => {
  reset();
  const { token } = await pair();
  devices[0].revoked_at = new Date().toISOString();
  const revoked = await req("config", { method: "GET", token });
  assertEquals(revoked.status, 401);
  assertEquals((await revoked.json()).code, "device_revoked"); // the app unpairs only on this code
  assertEquals((await req("config", { method: "GET", token: "not-a-real-token" })).status, 401);
  assertEquals((await req("config", { method: "GET" })).status, 401);
});

Deno.test("config: paused or cancelled client -> texting off but still paired; reactivating needs no re-pair", async () => {
  reset();
  const { token } = await pair();
  for (const status of ["paused", "cancelled"]) {
    clients[0].status = status;
    const r = await req("config", { method: "GET", token });
    assertEquals(r.status, 200);
    const cfg = await r.json();
    assertEquals(cfg.rules.enabled, false);
    assertEquals(cfg.rules.disabled_reason, status);
  }
  clients[0].status = "active";
  assertEquals((await (await req("config", { method: "GET", token })).json()).rules.enabled, true);
});

Deno.test("config: owner switched Text-Back off -> texting off, still registered", async () => {
  reset();
  const { token } = await pair();
  settings[0].textback_app_enabled = false;
  const cfg = await (await req("config", { method: "GET", token })).json();
  assertEquals(cfg.rules.enabled, false);
  assertEquals(cfg.rules.disabled_reason, "switched_off");
  settings[0].textback_app_enabled = true;
  assertEquals((await (await req("config", { method: "GET", token })).json()).rules.enabled, true);
});

Deno.test("config: client's Twilio receptionist line is on -> phone doesn't text (no double text)", async () => {
  reset();
  const { token } = await pair();
  lines = [{ client_id: CLIENT, enabled: true }];
  let cfg = await (await req("config", { method: "GET", token })).json();
  assertEquals(cfg.rules.enabled, false);
  assertEquals(cfg.rules.disabled_reason, "twilio_line");
  lines[0].enabled = false;
  cfg = await (await req("config", { method: "GET", token })).json();
  assertEquals(cfg.rules.enabled, true);
  assertEquals(cfg.rules.disabled_reason, null);
});

Deno.test("config: DB down -> 503, never 401 (the app must keep texting, not unpair)", async () => {
  reset();
  const { token } = await pair();
  failDb = true;
  assertEquals((await req("config", { method: "GET", token })).status, 503);
});

// ---------- events ----------
const ev = (id: string, o: Record<string, unknown> = {}) => ({
  external_id: id, kind: "missed", from_phone: "(512) 555-1234", at: new Date().toISOString(), texted: true, ...o,
});

Deno.test("events: missed + texted -> missed_call and textback rows; same batch twice -> one each", async () => {
  reset();
  const { token, device_id } = await pair();
  const batch = [ev("101"), ev("102", { kind: "declined", texted: false })];
  for (let i = 0; i < 2; i++) {
    const r = await req("events", { body: batch, token });
    assertEquals(r.status, 200);
    assertEquals((await r.json()).accepted, 2);
  }
  assertEquals(messages.length, 3);
  const m101 = messages.find((m) => m.external_id === `dev:${device_id}:101`)!;
  assertEquals(m101.kind, "missed_call");
  assertEquals(m101.from_phone, "+15125551234");
  assertEquals(m101.client_id, CLIENT);
  const tb = messages.find((m) => m.external_id === `dev:${device_id}:101:textback`)!;
  assertEquals(tb.kind, "textback");
  assertEquals(tb.status, "handled");
  const m102 = messages.find((m) => m.external_id === `dev:${device_id}:102`)!;
  assertEquals((m102.meta as Row).call_type, "declined");
  assert(!messages.some((m) => m.external_id === `dev:${device_id}:102:textback`));
});

Deno.test("events: private number is logged without a number; bad items rejected, good ones kept", async () => {
  reset();
  const { token } = await pair();
  const r = await req("events", {
    token,
    body: [
      ev("201", { from_phone: "", texted: false }),       // private caller: kept, no number
      ev("202", { from_phone: "+18765551234" }),          // texted a Jamaican +1 number: rejected
      ev("203", { kind: "outgoing" }),                    // not a missed/declined call
      ev("204", { at: "2020-01-01T00:00:00Z" }),          // too old
      ev("bad id"),                                       // id must be the call-log _ID
      ev("205"),
    ],
  });
  const out = await r.json();
  assertEquals(out.accepted, 2);
  assertEquals(out.rejected.map((x: { index: number }) => x.index), [1, 2, 3, 4]);
  assertEquals(messages.find((m) => String(m.external_id).endsWith(":201"))!.from_phone, null);
});

Deno.test("events: more than 50 -> 413; revoked device -> 401; non-array -> 400", async () => {
  reset();
  const { token } = await pair();
  const many = Array.from({ length: 51 }, (_, i) => ev(String(i + 1)));
  assertEquals((await req("events", { body: many, token })).status, 413);
  assertEquals((await req("events", { body: { nope: 1 }, token })).status, 400);
  devices[0].revoked_at = new Date().toISOString();
  assertEquals((await req("events", { body: [ev("1")], token })).status, 401);
  assertEquals(messages.length, 0);
});

Deno.test("unknown route -> 404; wrong method -> 405", async () => {
  reset();
  assertEquals((await req("nope", { body: {} })).status, 404);
  assertEquals((await req("pair", { body: { code: "123456" } })).status, 404); // pairing codes are gone
  assertEquals((await req("register", { method: "GET" })).status, 405);
});

Deno.test("unregister: the phone's token is retired, frees a slot, and can't be used again", async () => {
  reset();
  const a = await pair();
  for (let i = 0; i < 4; i++) await pair();
  assertEquals((await register(OWNER_JWT)).status, 409); // 5 active: full
  assertEquals((await req("unregister", { body: {}, token: a.token })).status, 200);
  assert(devices.find((d) => d.token_hash === devices[0].token_hash)?.revoked_at);
  assertEquals((await req("config", { method: "GET", token: a.token })).status, 401);
  assertEquals((await register(OWNER_JWT)).status, 200); // a slot opened up
  assertEquals((await req("unregister", { body: {}, token: a.token })).status, 200); // repeat: no-op
});
