// ============================================================
// Lost Pines — lpc-request-notify (Supabase Edge Function)
//
// Called by the Lost Pines app or a web portal right after a customer inserts
// a row into lpc_requests (009). Emails the studio once per request:
//   1) Authenticates the caller from their JWT.
//   2) Loads the request with the service role, but only if the caller filed it.
//   3) Claims the request by stamping notified_at (only if still empty), then
//      sends one email via Resend, so a retry or a double tap never sends twice.
//      A failed send clears the stamp and returns 502 — the request itself is
//      already saved and on the admin hub, and a retry can send it.
//   4) Caps emails per customer per day (a spammy account can't flood the inbox;
//      its requests are still saved).
//
// Deploy with Verify JWT ON. Secrets: RESEND_API_KEY (already set),
// optional STUDIO_NOTIFY_EMAIL, INVITE_FROM. Injected: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.
// ============================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("INVITE_FROM") ?? "Lost Pines Creative <noreply@lostpinescreative.com>";
const TO = Deno.env.get("STUDIO_NOTIFY_EMAIL") ?? "ddesmit@lostpinescreative.com";
const ADMIN_URL = "https://lostpinescreative.com/admin/#requests";
const MAX_EMAILS_PER_USER_DAY = 10;
const T_EXT = 8000;

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://lostpinescreative.com,https://www.lostpinescreative.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const REST = `${SB_URL}/rest/v1`;
const svc = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SERVICE_LABEL: Record<string, string> = { groundwork: "Groundwork", desmit: "DeSmit Designs" };
const KIND_LABEL: Record<string, string> = {
  new_service: "New service", change: "Change to my setup", support: "Support", other: "Other",
};

async function fetchT(url: string, opts: RequestInit, ms = T_EXT): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}

// Browsers send Origin and must be on the allow-list; the native app sends none
// (CORS doesn't apply to it — the JWT is what authenticates every caller).
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

function escapeHtml(s: string) {
  return String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
}

function emailHtml(r: { service: string; kind: string; body: string }, who: string, business: string | null): string {
  const rows = [
    ["From", who], ["Brand", SERVICE_LABEL[r.service] ?? r.service], ["Type", KIND_LABEL[r.kind] ?? r.kind],
    ...(business ? [["Business", business]] : []),
  ].map(([k, v]) => `<tr><td style="color:#94a3b8;padding:4px 12px 4px 0">${k}</td>` +
    `<td style="color:#e2e8f0;padding:4px 0">${escapeHtml(v)}</td></tr>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#0b1210;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 0"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#111a17;border:1px solid #1f2d28;border-radius:12px">
<tr><td style="padding:24px 28px">
<p style="color:#e2e8f0;font-size:17px;font-weight:bold;margin:0 0 14px">New service request</p>
<table cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 16px">${rows}</table>
<div style="background:#0b1210;border:1px solid #1f2d28;border-radius:8px;padding:14px 16px;margin:0 0 20px">
<p style="color:#cbd5e1;font-size:14px;line-height:1.6;margin:0;white-space:pre-wrap">${escapeHtml(r.body)}</p></div>
<a href="${ADMIN_URL}" style="color:#7dd3a8;font-size:14px">Open requests in admin &rarr;</a>
</td></tr></table></td></tr></table></body></html>`;
}

async function rows(url: string): Promise<Array<Record<string, unknown>>> {
  const r = await fetchT(url, { headers: svc });
  if (!r.ok) throw new Error(`rest ${r.status}`);
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}

Deno.serve(async (req) => {
  const c = cors(req.headers.get("origin"));
  if (!c) return json({ error: "origin not allowed" }, 403);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, c);
  if (!RESEND_KEY) return json({ error: "email not configured" }, 500, c);

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "not signed in" }, 401, c);
    const uRes = await fetchT(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
    if (uRes.status === 401 || uRes.status === 403) return json({ error: "not signed in" }, 401, c);
    if (!uRes.ok) throw new Error(`auth ${uRes.status}`);
    const caller = await uRes.json();
    const callerId = String(caller?.id ?? "");
    if (!UUID.test(callerId)) return json({ error: "not signed in" }, 401, c);

    const body = await req.json().catch(() => null);
    const requestId = String(body?.request_id ?? "");
    if (!UUID.test(requestId)) return json({ error: "request_id required" }, 400, c);

    const [r] = await rows(`${REST}/lpc_requests?select=id,service,kind,body,client_id,notified_at` +
      `&id=eq.${requestId}&user_id=eq.${callerId}`);
    if (!r) return json({ error: "request not found" }, 404, c);
    if (r.notified_at) return json({ ok: true, sent: 0, already: true }, 200, c);

    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const recent = await rows(`${REST}/lpc_requests?select=id&user_id=eq.${callerId}` +
      `&notified_at=gte.${encodeURIComponent(dayAgo)}`);
    if (recent.length >= MAX_EMAILS_PER_USER_DAY) return json({ ok: true, sent: 0, capped: true }, 200, c);

    const [client] = r.client_id
      ? await rows(`${REST}/gw_clients?select=business_name&id=eq.${r.client_id}`)
      : [];
    // Claim: only one caller can flip notified_at from empty.
    const claim = await fetchT(`${REST}/lpc_requests?id=eq.${requestId}&notified_at=is.null&select=id`, {
      method: "PATCH", headers: { ...svc, Prefer: "return=representation" },
      body: JSON.stringify({ notified_at: new Date().toISOString() }),
    });
    if (!claim.ok) throw new Error(`claim ${claim.status}`);
    if (!((await claim.json()) as unknown[]).length) return json({ ok: true, sent: 0, already: true }, 200, c);

    const who = String(caller?.email ?? "a customer");
    const subject = `Request: ${KIND_LABEL[String(r.kind)] ?? r.kind} — ${SERVICE_LABEL[String(r.service)] ?? r.service}`;
    const send = await fetchT("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [TO], reply_to: caller?.email ? [String(caller.email)] : undefined, subject,
        html: emailHtml(r as { service: string; kind: string; body: string }, who,
          (client?.business_name as string) ?? null),
      }),
    });
    if (!send.ok) {
      console.error("resend failed", send.status);
      await fetchT(`${REST}/lpc_requests?id=eq.${requestId}`, {
        method: "PATCH", headers: { ...svc, Prefer: "return=minimal" },
        body: JSON.stringify({ notified_at: null }),
      }).catch(() => {});
      return json({ error: "couldn't send the email — your request is saved" }, 502, c);
    }
    return json({ ok: true, sent: 1 }, 200, c);
  } catch (e) {
    console.error("request-notify error", String(e));
    return json({ error: "temporarily unavailable — your request is saved" }, 503, c);
  }
});
