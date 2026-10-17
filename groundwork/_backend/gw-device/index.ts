// ============================================================
// Groundwork — Text-Back Android app backend (Supabase Edge Function)
//
// The client's own Android phone texts missed callers from the owner's number
// (no Twilio cost) and talks to this function:
//
//   POST /register {client_id, label?, app_version?} + Bearer <owner's Supabase JWT>
//                 -> {device_id, token}. The owner signs into the Lost Pines app;
//                 ownership is checked by reading gw_clients WITH THE OWNER'S JWT
//                 (RLS / gw_owns_client decides). Admin accounts are refused so a
//                 studio-wide session never ends up on a customer's phone;
//                 cancelled clients are refused. The token is what the app's
//                 headless worker uses from then on (it can't refresh a session).
//   GET  /config  -> {business_name, textback_message, rules: {enabled, disabled_reason, per_number_hours}}
//                 The app calls this before every text (D9). Only a 401 whose
//                 body has code "device_revoked" means unpair and don't text —
//                 a gateway 401 (e.g. a redeploy with Verify JWT on) must not
//                 unpair every phone. Anything else -> text from cached config.
//   POST /unregister  (device token) -> the owner turned Text-Back off on this
//                 phone: retire its token (revoked_at) so it stops counting
//                 toward the 5-phone limit and can never be used again.
//   POST /events  [{external_id, kind, from_phone, at, texted}] (max 50)
//                 One missed_call row per call (+ a textback row if texted)
//                 in gw_messages, idempotent on external_id.
//
// Only missed-call events leave the phone — never the call log or contacts (D7).
//
// Agent Build Standard v1.2 controls: SEC-01 (owner JWT for /register, hashed
// device token after, fail closed), REL-01 (timeouts), REL-04 (caps, active
// phones per client), OBS-01 (metadata-only trace), PRIV-01.
//
// Injected: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// Deploy with Verify JWT OFF (called by the phone with a device token).
// ============================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const FN_NAME = "gw-device";

// REL-04 caps.
const MAX_BODY_BYTES = 64_000;
const MAX_EVENTS = 50;
const MAX_EVENT_AGE_MS = 30 * 86_400_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_ACTIVE_PHONES = 5; // per client; revoke one in admin to add another

const TEXTBACK_PER_NUMBER_HOURS = 24;

// REL-01 timeouts. /config sits in front of every text, so keep it quick.
const T_DB = 2500;
const T_LAST_SEEN = 500; // cosmetic write; must not eat the app's 3 s preflight

const REST = `${SB_URL}/rest/v1`;
const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

async function fetchT(url: string, opts: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// OBS-01: metadata only — never phone numbers, emails, or tokens.
function trace(o: Record<string, unknown>) {
  try { console.log(JSON.stringify({ evt: "agent_run", fn: FN_NAME, ...o })); } catch (_e) { /* noop */ }
}

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Phone helpers — same rules as gw-reception (and the app's PhoneNumbers.kt). ──
function toE164(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const d = s.replace(/\D/g, "");
  if (s.startsWith("+") && d.length >= 8 && d.length <= 15) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}
const NON_US_CA_NPA = new Set([
  "242", "246", "264", "268", "284", "345", "441", "473", "649", "658", "664",
  "721", "758", "767", "784", "809", "829", "849", "868", "869", "876", "900",
]);
const isNanp = (n: string | null): n is string =>
  !!n && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(n) && !NON_US_CA_NPA.has(n.slice(2, 5));

// ============================================================
// /register
// ============================================================
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The signed-in user, or null for a bad/expired session. Throws if Auth is down.
async function sessionUser(jwt: string): Promise<{ id: string } | null> {
  const r = await fetchT(`${SB_URL}/auth/v1/user`,
    { headers: { apikey: SB_ANON, Authorization: `Bearer ${jwt}` } }, T_DB);
  if (r.status === 401 || r.status === 403) return null;
  if (!r.ok) throw new Error(`auth ${r.status}`);
  const u = await r.json();
  return u?.id ? { id: String(u.id) } : null;
}

// deno-lint-ignore no-explicit-any
async function onRegister(req: Request, body: any, traceId: string, t0: number): Promise<Response> {
  const done = (outcome: string, res: Response) => {
    trace({ traceId, route: "register", outcome, ms: Date.now() - t0 });
    return res;
  };
  const m = /^Bearer\s+(\S{20,4096})$/.exec(req.headers.get("authorization") ?? "");
  const user = m ? await sessionUser(m[1]) : null;
  if (!m || !user) return done("no_session", json({ error: "sign in again", code: "not_signed_in" }, 401));
  const clientId = String(body?.client_id ?? "");
  if (!UUID.test(clientId)) return done("bad_request", json({ error: "client_id required" }, 400));

  // Admins can see every client, so they must never register one (D14).
  const pr = await fetchT(`${REST}/dd_profiles?select=is_admin&id=eq.${user.id}`, { headers: sbHeaders }, T_DB);
  if (!pr.ok) throw new Error(`profile ${pr.status}`);
  const prof = (await pr.json())[0];
  if (prof?.is_admin) {
    return done("admin_refused", json({ error: "sign in with the business owner's account", code: "admin_account" }, 403));
  }

  // Ownership: the owner's own JWT reads gw_clients, so RLS (gw_owns_client) decides.
  const cr = await fetchT(`${REST}/gw_clients?select=id,status&id=eq.${clientId}`,
    { headers: { apikey: SB_ANON, Authorization: `Bearer ${m[1]}` } }, T_DB);
  if (!cr.ok) throw new Error(`client ${cr.status}`);
  const client = (await cr.json())[0];
  if (!client) return done("not_owner", json({ error: "this account doesn't own that business", code: "not_owner" }, 403));
  if (client.status === "cancelled") {
    return done("cancelled", json({ error: "this service has ended", code: "client_cancelled" }, 409));
  }

  const ar = await fetchT(`${REST}/gw_devices?select=id&client_id=eq.${clientId}&revoked_at=is.null`,
    { headers: { ...sbHeaders, Prefer: "count=exact", Range: "0-0" } }, T_DB);
  if (!ar.ok) throw new Error(`count ${ar.status}`);
  const active = Number((ar.headers.get("content-range") ?? "*/0").split("/")[1] || "0") || 0;
  if (active >= MAX_ACTIVE_PHONES) {
    return done("too_many", json({ error: "too many phones — remove one first", code: "too_many_phones" }, 409));
  }

  const token = newToken();
  const ins = await fetchT(`${REST}/gw_devices?select=id`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=representation" },
    body: JSON.stringify({
      client_id: clientId,
      registered_by: user.id,
      token_hash: await sha256Hex(token),
      label: clip(body?.label, 60) || null,
      app_version: clip(body?.app_version, 20) || null,
      last_seen_at: new Date().toISOString(),
    }),
  }, T_DB);
  if (!ins.ok) throw new Error(`device insert ${ins.status}`);
  const dev = (await ins.json())[0];
  return done("registered", json({ device_id: dev.id, token }));
}

// ============================================================
// Device auth
// ============================================================
type Device = {
  id: string; client_id: string; business_name: string; client_status: string;
  textback_message: string | null;
  switched_off: boolean;   // the owner turned Text-Back off (absent settings row = on)
  twilio_line_on: boolean; // gw-reception already texts this client's missed callers
};

// null = revoked or unknown (-> 401). A paused or cancelled client keeps its
// registration (texting is switched off in /config), so reactivating needs no
// new sign-in. Throws on a DB failure (-> 503), so a blip never looks like a
// revocation and the app keeps texting from cache.
async function authDevice(req: Request): Promise<Device | null> {
  const m = /^Bearer\s+([\w-]{20,200})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const sel = "id,client_id,revoked_at,client:gw_clients(business_name,status,settings:gw_settings(textback_message,textback_app_enabled),line:gw_reception_lines(enabled))";
  const r = await fetchT(`${REST}/gw_devices?select=${sel}&token_hash=eq.${await sha256Hex(m[1])}&limit=1`,
    { headers: sbHeaders }, T_DB);
  if (!r.ok) throw new Error(`device lookup ${r.status}`);
  const rows = await r.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.client || row.revoked_at) return null;
  const one = (v: unknown) => Array.isArray(v) ? v[0] : v;
  const s = one(row.client.settings);
  return {
    id: row.id, client_id: row.client_id,
    business_name: row.client.business_name, client_status: row.client.status,
    textback_message: s?.textback_message ?? null,
    switched_off: s?.textback_app_enabled === false,
    twilio_line_on: one(row.client.line)?.enabled === true,
  };
}

// ============================================================
// /config
// ============================================================
async function onConfig(dev: Device, req: Request, traceId: string, t0: number): Promise<Response> {
  try {
    const v = clip(req.headers.get("x-app-version"), 20);
    await fetchT(`${REST}/gw_devices?id=eq.${dev.id}`, {
      method: "PATCH",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ last_seen_at: new Date().toISOString(), ...(v ? { app_version: v } : {}) }),
    }, T_LAST_SEEN);
  } catch { /* last-seen is cosmetic */ }
  const message = clip(dev.textback_message, 400) ||
    `Sorry we missed your call at ${dev.business_name}! Reply here with what you need and we'll get right back to you.`;
  const off = dev.client_status === "paused" || dev.client_status === "cancelled";
  trace({ traceId, route: "config", outcome: "ok", ms: Date.now() - t0 });
  return json({
    business_name: dev.business_name,
    textback_message: message,
    rules: {
      // One text per missed caller: when the Twilio receptionist line is on, it
      // sends the text-back and the phone only reports the missed call.
      enabled: !off && !dev.switched_off && !dev.twilio_line_on,
      disabled_reason: off ? dev.client_status : dev.switched_off ? "switched_off"
        : dev.twilio_line_on ? "twilio_line" : null,
      per_number_hours: TEXTBACK_PER_NUMBER_HOURS,
    },
  });
}

// ============================================================
// /unregister
// ============================================================
async function onUnregister(dev: Device, traceId: string, t0: number): Promise<Response> {
  const r = await fetchT(`${REST}/gw_devices?id=eq.${dev.id}&revoked_at=is.null`, {
    method: "PATCH",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  }, T_DB);
  if (!r.ok) throw new Error(`unregister ${r.status}`);
  trace({ traceId, route: "unregister", outcome: "ok", ms: Date.now() - t0 });
  return json({ ok: true });
}

// ============================================================
// /events
// ============================================================
// deno-lint-ignore no-explicit-any
function eventRows(dev: Device, e: any): Record<string, unknown>[] | string {
  const id = String(e?.external_id ?? "");
  if (!/^\d{1,20}$/.test(id)) return "external_id must be the call-log id";
  const kind = e?.kind;
  if (kind !== "missed" && kind !== "declined") return "kind must be missed or declined";
  const at = Date.parse(String(e?.at ?? ""));
  const now = Date.now();
  if (!Number.isFinite(at) || at < now - MAX_EVENT_AGE_MS || at > now + MAX_CLOCK_SKEW_MS) return "bad time";
  const texted = e?.texted === true;
  const phone = toE164(e?.from_phone); // private / blocked callers arrive empty -> null
  if (texted && !isNanp(phone)) return "texted a number outside US/Canada";

  const key = `dev:${dev.id}:${id}`;
  const createdAt = new Date(at).toISOString();
  const meta = { via: FN_NAME, device_id: dev.id, call_type: kind, texted };
  const rows: Record<string, unknown>[] = [{
    client_id: dev.client_id, external_id: key, kind: "missed_call", from_phone: phone,
    body: kind === "declined" ? "Declined call." : "Missed call.", meta, created_at: createdAt,
  }];
  if (texted) {
    rows.push({
      client_id: dev.client_id, external_id: `${key}:textback`, kind: "textback", from_phone: phone,
      body: "Text-back sent from your phone.", status: "handled", meta, created_at: createdAt,
    });
  }
  return rows;
}

// deno-lint-ignore no-explicit-any
async function onEvents(dev: Device, body: any, traceId: string, t0: number): Promise<Response> {
  if (!Array.isArray(body)) return json({ error: "expected an array of events" }, 400);
  if (body.length > MAX_EVENTS) return json({ error: `at most ${MAX_EVENTS} events per request` }, 413);
  const rows = new Map<string, Record<string, unknown>>();
  const rejected: { index: number; reason: string }[] = [];
  let accepted = 0;
  body.forEach((e, index) => {
    const out = eventRows(dev, e);
    if (typeof out === "string") { rejected.push({ index, reason: out }); return; }
    accepted++;
    for (const r of out) rows.set(String(r.external_id), r);
  });
  if (rows.size) {
    // ignore-duplicates: a re-sent batch never rewrites (or re-homes) a row.
    const r = await fetchT(`${REST}/gw_messages?on_conflict=external_id`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify([...rows.values()]),
    }, T_DB);
    if (!r.ok) throw new Error(`events upsert ${r.status}`); // 503 -> the app keeps them queued
  }
  trace({ traceId, route: "events", outcome: "ok", accepted, rejected: rejected.length, ms: Date.now() - t0 });
  return json({ accepted, rejected });
}

// ============================================================
Deno.serve(async (req) => {
  const traceId = crypto.randomUUID();
  const t0 = Date.now();
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  const want: Record<string, string> = { register: "POST", config: "GET", events: "POST", unregister: "POST" };
  if (!route || !want[route]) return json({ error: "not found" }, 404);
  if (req.method !== want[route]) return json({ error: "method not allowed" }, 405);
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return json({ error: "too large" }, 413);

  try {
    // deno-lint-ignore no-explicit-any
    let body: any = null;
    if (req.method === "POST") {
      const raw = await req.text().catch(() => "");
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ error: "too large" }, 413); // chunked bodies too
      try { body = JSON.parse(raw); } catch { return json({ error: "invalid JSON" }, 400); }
    }
    if (route === "register") return await onRegister(req, body, traceId, t0);

    const dev = await authDevice(req);
    if (!dev && route === "unregister") return json({ ok: true }); // already gone: nothing to do
    if (!dev) {
      trace({ traceId, route, outcome: "unauthorized", ms: Date.now() - t0 });
      return json({ error: "device not paired", code: "device_revoked" }, 401);
    }
    if (route === "config") return await onConfig(dev, req, traceId, t0);
    if (route === "unregister") return await onUnregister(dev, traceId, t0);
    return await onEvents(dev, body, traceId, t0);
  } catch (e) {
    console.error("device error", route, String(e));
    trace({ traceId, route, outcome: "error", ms: Date.now() - t0 });
    return json({ error: "temporarily unavailable" }, 503);
  }
});
