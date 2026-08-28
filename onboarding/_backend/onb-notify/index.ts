// ============================================================
// Onboarding — onb-notify (Supabase Edge Function)
//
// Emails the studio owner when a client SUBMITS their onboarding brief, so they
// know to review the scope and send a quote (which unlocks sign + pay).
//
//   1) Authenticate the caller from their JWT.
//   2) Confirm the intake is theirs (or they're admin) AND is actually submitted.
//   3) Email the owner a short summary + a link to the admin console. Best-effort;
//      a mail failure never blocks the client's submit.
//
// Deploy with Verify JWT ON.
// Secrets: RESEND_API_KEY, OWNER_EMAIL. Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// ============================================================
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("INVITE_FROM") ?? "Lost Pines Creative <noreply@lostpinescreative.com>";
const OWNER_EMAIL = Deno.env.get("OWNER_EMAIL") ?? "ddesmit@lostpinescreative.com";
const ADMIN_URL = "https://lostpinescreative.com/onboarding/admin.html";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://lostpinescreative.com,https://www.lostpinescreative.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const REST = `${SB_URL}/rest/v1`;
const AUTH = `${SB_URL}/auth/v1`;
const svc = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

// Reject anything that isn't a plain UUID before it reaches a PostgREST filter.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
function escapeHtml(s: string) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const c = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, c);
  if (c["Access-Control-Allow-Origin"] === DENY_ORIGIN) return json({ error: "origin not allowed" }, 403, c);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "not signed in" }, 401, c);
  const uRes = await fetch(`${AUTH}/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!uRes.ok) return json({ error: "not signed in" }, 401, c);
  const caller = await uRes.json();
  const callerId: string = caller?.id;
  if (!callerId) return json({ error: "not signed in" }, 401, c);

  const body = await req.json().catch(() => null);
  const intakeId = String(body?.intake_id ?? "").trim();
  if (!UUID_RE.test(intakeId)) return json({ error: "invalid intake" }, 400, c);

  const rows = await getRows(`${REST}/onb_intakes?id=eq.${intakeId}&select=owner_id,status,business_name,contact_email,contact_name,package,care_plan,product`);
  if (!rows.length) return json({ error: "intake not found" }, 404, c);
  const it = rows[0] as Record<string, string>;
  if (it.owner_id !== callerId) {
    const adm = await getRows(`${REST}/dd_profiles?id=eq.${callerId}&is_admin=eq.true&select=id`);
    if (!adm.length) return json({ error: "not allowed" }, 403, c);
  }
  // Only notify for a genuinely-submitted brief (ignore stray/draft calls).
  if (it.status !== "submitted" && it.status !== "in_review") {
    return json({ ok: true, skipped: "not submitted" }, 200, c);
  }

  if (RESEND_KEY) {
    const summary =
      `<div style="font-family:Arial,sans-serif;background:#0a0e17;color:#e2e8f0;padding:24px">
        <h2 style="color:#fff;margin:0 0 12px">New onboarding brief submitted</h2>
        <p style="margin:0 0 6px"><b>${escapeHtml(it.business_name || "(no name)")}</b> — ${escapeHtml(it.product || "")}</p>
        <p style="color:#94a3b8;margin:0 0 4px">Contact: ${escapeHtml(it.contact_name || "")} · ${escapeHtml(it.contact_email || "")}</p>
        <p style="color:#94a3b8;margin:0 0 16px">Requested: ${escapeHtml(it.package || "—")} · care ${escapeHtml(it.care_plan || "none")}</p>
        <p><a href="${ADMIN_URL}" style="display:inline-block;background:#4a9e7e;color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:bold">Review &amp; quote →</a></p>
        <p style="color:#64748b;font-size:12px;margin-top:16px">Set the deposit and mark it <b>accepted</b> to unlock the client's sign &amp; pay.</p>
      </div>`;
    const mail = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [OWNER_EMAIL],
        reply_to: it.contact_email || undefined,
        subject: `New brief: ${it.business_name || "onboarding"} (${it.package || "unscoped"})`,
        html: summary,
      }),
    }).catch((e) => { console.error("resend failed", e); return null; });
    if (mail && !mail.ok) console.error("resend non-200", await mail.text());
  }

  // Audit trail (best-effort).
  await fetch(`${REST}/onb_events`, {
    method: "POST", headers: { ...svc, Prefer: "return=minimal" },
    body: JSON.stringify({ intake_id: intakeId, actor_id: callerId, kind: "submitted_notified", detail: {} }),
  }).catch(() => {});

  return json({ ok: true }, 200, c);
});

async function getRows(url: string): Promise<Array<Record<string, unknown>>> {
  try {
    const r = await fetch(url, { headers: svc });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}
