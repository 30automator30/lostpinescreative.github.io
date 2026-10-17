// ============================================================
// Groundwork — Text-Back Android app backend (Supabase Edge Function)
//
// The client's own Android phone texts missed callers from the owner's number
// (no Twilio cost) and talks to this function:
//
//   POST /pair    {code, label?, app_version?} -> {device_id, token}
//                 6-digit admin-issued code (gw_create_pairing_code), single
//                 use, 10 minutes. Rate-limited per IP and globally.
//   GET  /config  -> {business_name, textback_message, rules}
//                 The app calls this before every text (D9). Only a 401 whose
//                 body has code "device_revoked" means unpair and don't text —
//                 a gateway 401 (e.g. a redeploy with Verify JWT on) must not
//                 unpair every phone. Anything else -> text from cached config.
//   POST /events  [{external_id, kind, from_phone, at, texted}] (max 50)
//                 One missed_call row per call (+ a textback row if texted)
//                 in gw_messages, idempotent on external_id.
//
// Only missed-call events leave the phone — never the call log or contacts (D7).
//
// Agent Build Standard v1.2 controls: SEC-01 (hashed device token, fail
// closed), REL-01 (timeouts), REL-04 (caps), COST-01 (pairing rate limits,
// fail closed), OBS-01 (metadata-only trace), PRIV-01.
//
// Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy with Verify JWT OFF (called by the phone with a device token).
// ============================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const FN_NAME = "gw-device";
const RL_PAIR = `${FN_NAME}-pair`;          // ai_call_log.fn for every pairing attempt
const RL_PAIR_FAIL = `${FN_NAME}-pair-fail`; // ai_call_log.fn for failed attempts

// REL-04 caps.
const MAX_BODY_BYTES = 64_000;
const MAX_EVENTS = 50;
const MAX_EVENT_AGE_MS = 30 * 86_400_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

// COST-01: pairing attempts. 1,000,000 codes, 10-minute life — a global
// failure ceiling makes guessing hopeless even from rotating IPs.
const RL_PAIR_PER_IP_HOUR = 5;
const RL_PAIR_FAIL_HOUR = Number(Deno.env.get("RL_PAIR_FAIL_HOUR") ?? "30");

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

// OBS-01: metadata only — never phone numbers, codes, or tokens.
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

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return xff.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
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
// /pair
// ============================================================
async function countLog(params: string): Promise<number> {
  const r = await fetchT(`${REST}/ai_call_log?select=id&${params}`, {
    headers: { ...sbHeaders, Prefer: "count=exact", Range: "0-0" },
  }, T_DB);
  if (!r.ok) throw new Error(`count ${r.status}`);
  return Number((r.headers.get("content-range") ?? "*/0").split("/")[1] || "0") || 0;
}

async function logAttempt(fn: string, ip: string): Promise<void> {
  try {
    await fetchT(`${REST}/ai_call_log`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ fn, ip }),
    }, T_DB);
  } catch { /* best effort; the ceilings fail closed on read */ }
}

// Fails CLOSED: if the ledger can't be read, nobody pairs.
async function pairAllowed(ip: string): Promise<boolean> {
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  try {
    const [perIp, failed] = await Promise.all([
      countLog(`fn=eq.${RL_PAIR}&ip=eq.${encodeURIComponent(ip)}&created_at=gte.${hourAgo}`),
      countLog(`fn=eq.${RL_PAIR_FAIL}&created_at=gte.${hourAgo}`),
    ]);
    return perIp < RL_PAIR_PER_IP_HOUR && failed < RL_PAIR_FAIL_HOUR;
  } catch {
    return false;
  }
}

// deno-lint-ignore no-explicit-any
async function onPair(body: any, ip: string, traceId: string, t0: number): Promise<Response> {
  if (!(await pairAllowed(ip))) {
    trace({ traceId, route: "pair", outcome: "rate_limited", ms: Date.now() - t0 });
    return json({ error: "too many attempts — try again later" }, 429);
  }
  await logAttempt(RL_PAIR, ip);
  const code = String(body?.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) return json({ error: "code must be 6 digits" }, 400);

  // Claim atomically: only an unused, unexpired code flips to used.
  const now = new Date().toISOString();
  const q = `code_hash=eq.${await sha256Hex(code)}&used_at=is.null&expires_at=gt.${encodeURIComponent(now)}`;
  const r = await fetchT(`${REST}/gw_pairing_codes?${q}&select=client_id`, {
    method: "PATCH",
    headers: { ...sbHeaders, Prefer: "return=representation" },
    body: JSON.stringify({ used_at: now }),
  }, T_DB);
  if (!r.ok) throw new Error(`claim ${r.status}`);
  const rows = await r.json();
  const clientId = Array.isArray(rows) && rows.length ? String(rows[0].client_id) : "";
  if (!clientId) {
    await logAttempt(RL_PAIR_FAIL, ip);
    trace({ traceId, route: "pair", outcome: "bad_code", ms: Date.now() - t0 });
    return json({ error: "that code is wrong or has expired" }, 401);
  }

  const token = newToken();
  const ins = await fetchT(`${REST}/gw_devices?select=id`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=representation" },
    body: JSON.stringify({
      client_id: clientId,
      token_hash: await sha256Hex(token),
      label: clip(body?.label, 60) || null,
      app_version: clip(body?.app_version, 20) || null,
      last_seen_at: now,
    }),
  }, T_DB);
  if (!ins.ok) throw new Error(`device insert ${ins.status}`); // code is burnt; admin issues a new one
  const dev = (await ins.json())[0];
  trace({ traceId, route: "pair", outcome: "paired", ms: Date.now() - t0 });
  return json({ device_id: dev.id, token });
}

// ============================================================
// Device auth
// ============================================================
type Device = {
  id: string; client_id: string; business_name: string; client_status: string;
  textback_message: string | null;
};

// null = not a live device (-> 401). Throws on a DB failure (-> 503), so a
// blip never looks like a revocation and the app keeps texting from cache.
async function authDevice(req: Request): Promise<Device | null> {
  const m = /^Bearer\s+([\w-]{20,200})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const sel = "id,client_id,revoked_at,client:gw_clients(business_name,status,settings:gw_settings(textback_message))";
  const r = await fetchT(`${REST}/gw_devices?select=${sel}&token_hash=eq.${await sha256Hex(m[1])}&limit=1`,
    { headers: sbHeaders }, T_DB);
  if (!r.ok) throw new Error(`device lookup ${r.status}`);
  const rows = await r.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.client || row.revoked_at) return null;
  if (row.client.status === "cancelled") return null;
  const s = Array.isArray(row.client.settings) ? row.client.settings[0] : row.client.settings;
  return {
    id: row.id, client_id: row.client_id,
    business_name: row.client.business_name, client_status: row.client.status,
    textback_message: s?.textback_message ?? null,
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
  trace({ traceId, route: "config", outcome: "ok", ms: Date.now() - t0 });
  return json({
    business_name: dev.business_name,
    textback_message: message,
    rules: {
      enabled: dev.client_status !== "paused",
      per_number_hours: TEXTBACK_PER_NUMBER_HOURS,
    },
  });
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
  const want: Record<string, string> = { pair: "POST", config: "GET", events: "POST" };
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
    if (route === "pair") return await onPair(body, clientIp(req), traceId, t0);

    const dev = await authDevice(req);
    if (!dev) {
      trace({ traceId, route, outcome: "unauthorized", ms: Date.now() - t0 });
      return json({ error: "device not paired", code: "device_revoked" }, 401);
    }
    if (route === "config") return await onConfig(dev, req, traceId, t0);
    return await onEvents(dev, body, traceId, t0);
  } catch (e) {
    console.error("device error", route, String(e));
    trace({ traceId, route, outcome: "error", ms: Date.now() - t0 });
    return json({ error: "temporarily unavailable" }, 503);
  }
});
