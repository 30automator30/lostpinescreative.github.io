// ============================================================
// DeSmit Designs — send-invite (Supabase Edge Function)
//
// Called by the portal / admin when a project is shared with someone. It:
//   1) Authenticates the caller (signed-in user) and checks they may share
//      this project (owner, an existing member, or an admin).
//   2) Ensures the invitee has an account, records the share row.
//   3) Generates a one-time magic sign-in link (lands them on the portal),
//      and emails it via Resend as a branded "you've been invited" message.
//
// Deploy with Verify JWT ON (only signed-in users may invite).
// Secrets: RESEND_API_KEY   (Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
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

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function emailHtml(projectTitle: string, inviter: string, link: string): string {
  const t = projectTitle || "a project";
  return `<!doctype html><html><body style="margin:0;background:#0a0e17;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e17;padding:32px 0">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#111827;border:1px solid #1e293b;border-radius:14px;overflow:hidden">
<tr><td style="background:linear-gradient(135deg,#3b82f6,#06b6d4);padding:22px 28px">
<span style="color:#fff;font-size:20px;font-weight:bold;letter-spacing:.5px">DeSmit Designs</span>
</td></tr>
<tr><td style="padding:28px">
<p style="color:#e2e8f0;font-size:16px;margin:0 0 14px">You've been invited to view a quote.</p>
<p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 22px">
${inviter ? escapeHtml(inviter) + " shared" : "Someone shared"} the project
<strong style="color:#e2e8f0">&ldquo;${escapeHtml(t)}&rdquo;</strong> with you in the DeSmit Designs client portal.
Click below to sign in and see its status, quote, and progress.</p>
<p style="margin:0 0 24px">
<a href="${escapeHtml(link)}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#06b6d4);color:#fff;text-decoration:none;font-size:15px;font-weight:bold;padding:13px 26px;border-radius:10px">View the quote &rarr;</a>
</p>
<p style="color:#64748b;font-size:12px;line-height:1.6;margin:0">
This sign-in link expires in about an hour and works once. You can always sign in later at
<a href="${PORTAL_URL}" style="color:#60a5fa">${PORTAL_URL}</a> with this email address.</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #1e293b">
<span style="color:#475569;font-size:12px">DeSmit Designs &middot; Bastrop, Texas &middot; a Lost Pines Creative studio</span>
</td></tr>
</table></td></tr></table></body></html>`;
}
function escapeHtml(s: string) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
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
  if (!callerId) return json({ error: "not signed in" }, 401, c);

  const body = await req.json().catch(() => null);
  const projectId = String(body?.project_id ?? "").trim();
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!projectId) return json({ error: "missing project" }, 400, c);
  if (!EMAIL_RE.test(email)) return json({ error: "please enter a valid email" }, 400, c);

  // ---- may the caller share this project? (admin, owner, or member) ----
  const [admin, owner, member, proj] = await Promise.all([
    getRows(`${REST}/dd_profiles?id=eq.${callerId}&is_admin=eq.true&select=id`),
    getRows(`${REST}/dd_projects?id=eq.${projectId}&customer_id=eq.${callerId}&select=id`),
    getRows(`${REST}/dd_project_shares?project_id=eq.${projectId}&user_id=eq.${callerId}&select=id`),
    getRows(`${REST}/dd_projects?id=eq.${projectId}&select=title`),
  ]);
  if (!admin.length && !owner.length && !member.length) {
    return json({ error: "not allowed to share this project" }, 403, c);
  }
  if (!proj.length) return json({ error: "project not found" }, 404, c);
  const projectTitle = proj[0].title as string;

  // ---- ensure the invitee has an account (email pre-confirmed) ----
  await fetch(`${AUTH}/admin/users`, {
    method: "POST", headers: svc,
    body: JSON.stringify({ email, email_confirm: true }),
  }); // 200 = created, 422 = already exists; either is fine

  const invitee = await getRows(`${REST}/dd_profiles?email=eq.${encodeURIComponent(email)}&select=id`);
  const inviteeId = invitee.length ? invitee[0].id : null;

  // ---- record the share (idempotent on project_id+email) ----
  const shareRes = await fetch(`${REST}/dd_project_shares?on_conflict=project_id,email`, {
    method: "POST",
    headers: { ...svc, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ project_id: projectId, email, user_id: inviteeId, invited_by: callerId }),
  });
  if (!shareRes.ok) {
    console.error("share insert failed", await shareRes.text());
    return json({ error: "couldn't record the share" }, 502, c);
  }

  // ---- generate a magic sign-in link that lands on the portal ----
  let link = PORTAL_URL;
  const linkRes = await fetch(`${AUTH}/admin/generate_link`, {
    method: "POST", headers: svc,
    body: JSON.stringify({ type: "magiclink", email, options: { redirect_to: PORTAL_URL } }),
  });
  if (linkRes.ok) {
    const d = await linkRes.json();
    link = d?.action_link || d?.properties?.action_link || PORTAL_URL;
  } else {
    console.error("generate_link failed", await linkRes.text());
  }

  // ---- send via Resend ----
  const inviterName = (caller?.user_metadata?.full_name as string) || (caller?.email as string) || "";
  const mailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [email],
      subject: `You've been invited to view a quote — DeSmit Designs`,
      html: emailHtml(projectTitle, inviterName, link),
    }),
  });
  if (!mailRes.ok) {
    console.error("resend failed", await mailRes.text());
    return json({ error: "shared, but the email couldn't be sent" }, 502, c);
  }
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
