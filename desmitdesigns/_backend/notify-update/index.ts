// ============================================================
// DeSmit Designs — notify-update (Supabase Edge Function)
//
// Called by the admin console (opt-in "Email the client" checkbox on the
// Post-update form) to email a project's client(s) that a new update was
// posted. It:
//   1) Authenticates the caller and checks they may touch this project
//      (admin, owner, or a shared member).
//   2) Collects the client recipients — the project owner + shared members —
//      minus the caller, and emails each one INDIVIDUALLY (never a shared To:,
//      so recipients never see each other's addresses).
//   3) Sends a branded "new update on your project" email via Resend with a
//      link to the portal and a short preview of the (customer-visible) note.
//
// Deploy with Verify JWT ON. Secret: RESEND_API_KEY (already set for
// send-invite). Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// ============================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("INVITE_FROM") ?? "DeSmit Designs <noreply@lostpinescreative.com>";
const PORTAL_URL = "https://lostpinescreative.com/desmitdesigns/portal/";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://lostpinescreative.com,https://www.lostpinescreative.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const REST = `${SB_URL}/rest/v1`;
const AUTH = `${SB_URL}/auth/v1`;
const svc = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

function cors(origin: string | null) {
  const ok = origin && (ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const json = (o: unknown, s: number, c: Record<string, string>) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...c } });

function escapeHtml(s: string) {
  return String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
}

function emailHtml(projectTitle: string, preview: string): string {
  const t = projectTitle || "your project";
  const note = preview
    ? `<div style="background:#0a0e17;border:1px solid #1e293b;border-radius:10px;padding:14px 16px;margin:0 0 22px">
<p style="color:#cbd5e1;font-size:14px;line-height:1.6;margin:0;white-space:pre-wrap">${escapeHtml(preview)}</p></div>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#0a0e17;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e17;padding:32px 0">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#111827;border:1px solid #1e293b;border-radius:14px;overflow:hidden">
<tr><td style="background:linear-gradient(135deg,#3b82f6,#06b6d4);padding:22px 28px">
<span style="color:#fff;font-size:20px;font-weight:bold;letter-spacing:.5px">DeSmit Designs</span>
</td></tr>
<tr><td style="padding:28px">
<p style="color:#e2e8f0;font-size:16px;margin:0 0 14px">There's a new update on your project.</p>
<p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 18px">
Daniel posted an update to <strong style="color:#e2e8f0">&ldquo;${escapeHtml(t)}&rdquo;</strong>
in your DeSmit Designs client portal.</p>
${note}
<p style="margin:0 0 24px">
<a href="${escapeHtml(PORTAL_URL)}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#06b6d4);color:#fff;text-decoration:none;font-size:15px;font-weight:bold;padding:13px 26px;border-radius:10px">View your project &rarr;</a>
</p>
<p style="color:#64748b;font-size:12px;line-height:1.6;margin:0">
Sign in at <a href="${escapeHtml(PORTAL_URL)}" style="color:#60a5fa">${PORTAL_URL}</a> with this email address to see the full progress, quote, and files.</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #1e293b">
<span style="color:#475569;font-size:12px">DeSmit Designs &middot; Bastrop, Texas &middot; a Lost Pines Creative studio</span>
</td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const c = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, c);
  if (c["Access-Control-Allow-Origin"] === "null") return json({ error: "origin not allowed" }, 403, c);
  if (!RESEND_KEY) return json({ error: "email not configured" }, 500, c);

  // ---- authenticate the caller from their JWT ----
  const authz = req.headers.get("Authorization") ?? "";
  const token = authz.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "not signed in" }, 401, c);
  const uRes = await fetch(`${AUTH}/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!uRes.ok) return json({ error: "not signed in" }, 401, c);
  const caller = await uRes.json();
  const callerId: string = caller?.id;
  const callerEmail: string = String(caller?.email ?? "").toLowerCase();
  if (!callerId) return json({ error: "not signed in" }, 401, c);

  const body = await req.json().catch(() => null);
  const projectId = String(body?.project_id ?? "").trim();
  const preview = String(body?.message ?? "").trim().slice(0, 400);
  if (!projectId) return json({ error: "missing project" }, 400, c);

  // ---- may the caller act on this project? (admin, owner, or member) ----
  const [admin, owner, member, proj] = await Promise.all([
    getRows(`${REST}/dd_profiles?id=eq.${callerId}&is_admin=eq.true&select=id`),
    getRows(`${REST}/dd_projects?id=eq.${projectId}&customer_id=eq.${callerId}&select=id`),
    getRows(`${REST}/dd_project_shares?project_id=eq.${projectId}&user_id=eq.${callerId}&select=id`),
    getRows(`${REST}/dd_projects?id=eq.${projectId}&select=title,customer_id`),
  ]);
  if (!admin.length && !owner.length && !member.length) {
    return json({ error: "not allowed for this project" }, 403, c);
  }
  if (!proj.length) return json({ error: "project not found" }, 404, c);
  const projectTitle = proj[0].title as string;
  const customerId = proj[0].customer_id as string;

  // ---- collect client recipients: owner + shared members, minus the caller ----
  const [ownerProfile, shares] = await Promise.all([
    getRows(`${REST}/dd_profiles?id=eq.${customerId}&select=email`),
    getRows(`${REST}/dd_project_shares?project_id=eq.${projectId}&select=email`),
  ]);
  const set = new Set<string>();
  const ownerEmail = String(ownerProfile[0]?.email ?? "").toLowerCase();
  if (ownerEmail) set.add(ownerEmail);
  for (const s of shares) {
    const e = String(s.email ?? "").toLowerCase();
    if (e) set.add(e);
  }
  set.delete(callerEmail);
  const recipients = [...set];
  if (!recipients.length) return json({ ok: true, sent: 0 }, 200, c);

  // ---- email each recipient individually ----
  const html = emailHtml(projectTitle, preview);
  const subject = `New update on “${projectTitle || "your project"}” — DeSmit Designs`;
  let sent = 0;
  for (const to of recipients) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });
    if (r.ok) sent++;
    else console.error("resend failed", to, await r.text());
  }
  if (!sent) return json({ error: "couldn't send the email" }, 502, c);
  return json({ ok: true, sent }, 200, c);
});

async function getRows(url: string): Promise<Array<Record<string, unknown>>> {
  try {
    const r = await fetch(url, { headers: svc });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}
