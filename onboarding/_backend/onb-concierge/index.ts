// ============================================================
// Onboarding — onb-concierge (Supabase Edge Function)
//
// The intake concierge. When a client SUBMITS their brief it:
//   1) Auto-acknowledges the PROSPECT — an on-brand "we've got it, here's what
//      happens next" email, immediately.
//   2) Reviews the brief with Claude — qualifies the lead, recommends a package,
//      flags gaps/red-flags, and DRAFTS a personal reply.
//   3) Emails YOU (the owner) that review + draft, ready to approve & send.
//
// Human-in-the-loop by design: the prospect gets an instant acknowledgement, but
// the personal reply is a draft for you to send — never auto-sent to the client.
// Supersedes onb-notify (does everything it did, plus the AI review).
//
// Deploy with Verify JWT ON. Secrets: RESEND_API_KEY, ANTHROPIC_API_KEY (both
// optional — it degrades gracefully), OWNER_EMAIL, optional ANTHROPIC_MODEL.
// Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// ============================================================
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5";
const FROM = Deno.env.get("INVITE_FROM") ?? "Groundwork <noreply@lostpinescreative.com>";
const OWNER_EMAIL = Deno.env.get("OWNER_EMAIL") ?? "ddesmit@lostpinescreative.com";
const ADMIN_URL = "https://lostpinescreative.com/onboarding/admin.html";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://lostpinescreative.com,https://www.lostpinescreative.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const REST = `${SB_URL}/rest/v1`;
const AUTH = `${SB_URL}/auth/v1`;
const svc = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STUDIO: Record<string, string> = { desmit: "DeSmit Designs", groundwork: "Groundwork" };

// Best-effort per-user rate cap (in-memory; resets on cold start — the
// authoritative backstop is an Anthropic account spend limit). Bounds how fast a
// single account can spend LLM tokens across many intakes.
const RL = new Map<string, number[]>();
function rateOk(uid: string, max = 8, windowMs = 60000): boolean {
  const now = Date.now();
  const arr = (RL.get(uid) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { RL.set(uid, arr); return false; }
  arr.push(now); RL.set(uid, arr);
  return true;
}

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
function esc(s: string) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
// naive markdown → minimal HTML (bold + line breaks) for the owner email
function mdLite(s: string) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
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
  if (!rateOk(callerId)) return json({ error: "too many requests — please slow down" }, 429, c);

  const body = await req.json().catch(() => null);
  const intakeId = String(body?.intake_id ?? "").trim();
  if (!UUID_RE.test(intakeId)) return json({ error: "invalid intake" }, 400, c);

  const rows = await getRows(`${REST}/onb_intakes?id=eq.${intakeId}&select=owner_id,status,product,business_name,industry,business_description,contact_name,contact_email,contact_phone,package,care_plan,billing_cycle,spec,about`);
  if (!rows.length) return json({ error: "intake not found" }, 404, c);
  const it = rows[0] as Record<string, any>;
  if (it.owner_id !== callerId) {
    const adm = await getRows(`${REST}/dd_profiles?id=eq.${callerId}&is_admin=eq.true&select=id`);
    if (!adm.length) return json({ error: "not allowed" }, 403, c);
  }
  if (it.status !== "submitted" && it.status !== "in_review") {
    return json({ ok: true, skipped: "not submitted" }, 200, c);
  }
  // Idempotency LOCK — insert the concierge event FIRST. The partial unique index
  // (onb_events_concierge_uniq) makes any concurrent/duplicate call 409 here, so
  // the expensive LLM + emails below run at most once per intake (closes the
  // read-then-act TOCTOU that could otherwise amplify cost).
  const lock = await fetch(`${REST}/onb_events`, {
    method: "POST", headers: { ...svc, Prefer: "return=minimal" },
    body: JSON.stringify({ intake_id: intakeId, actor_id: callerId, kind: "concierge_reviewed", detail: {} }),
  });
  if (lock.status === 409) return json({ ok: true, skipped: "already handled" }, 200, c);
  if (!lock.ok) console.error("concierge lock insert", lock.status, await lock.text().catch(() => ""));

  const studio = STUDIO[String(it.product)] ?? "Groundwork";
  const firstName = String(it.contact_name ?? "").trim().split(/\s+/)[0] || "there";
  const biz = String(it.business_name ?? "your business");
  // Acknowledge the VERIFIED account email (from the JWT), never the client-typed
  // contact_email — otherwise a client could use our sending domain to email an
  // arbitrary address. The owner email still carries contact_email for the reply.
  const prospectEmail = String(caller?.email ?? "").trim();

  // ---- 1) auto-acknowledge the prospect (best-effort) ----
  if (RESEND_KEY && prospectEmail) {
    await sendEmail([prospectEmail], `We've got your brief — ${biz}`, ackHtml(studio, firstName, biz))
      .catch((e) => console.error("ack email", e));
  }

  // ---- 2) review + draft with Claude (best-effort) ----
  let review = "";
  if (ANTHROPIC_KEY) {
    review = await claudeReview(studio, it).catch((e) => { console.error("claude", e); return ""; });
  }

  // ---- 3) email the owner the review + draft (best-effort) ----
  if (RESEND_KEY) {
    await sendEmail([OWNER_EMAIL], `New brief + draft reply: ${biz}`, ownerHtml(studio, it, review), it.contact_email)
      .catch((e) => console.error("owner email", e));
  }

  return json({ ok: true }, 200, c);
});

/* ---- Claude review ---- */
function chosen(spec: any): string {
  const out: string[] = [];
  for (const col of ["integrations", "sections"]) {
    const o = (spec && spec[col]) || {};
    for (const k of Object.keys(o)) {
      const v = o[k] || {};
      if (v.include) out.push(k);
      else if (v.dev_decides) out.push(`${k} (dev decides)`);
    }
  }
  return out.join(", ") || "—";
}
async function claudeReview(studio: string, it: Record<string, any>): Promise<string> {
  const spec = it.spec || {};
  const prompt =
`New client onboarding brief for ${studio} (a small local-business web + AI studio, part of Lost Pines Creative):

Business: ${it.business_name || "—"} (${it.industry || "industry not given"})
What they do: ${it.business_description || "—"}
Package requested: ${it.package || "not chosen"}; care plan: ${it.care_plan || "none"} (${it.billing_cycle || "monthly"})
Selected features: ${chosen(spec)}
Goal: ${spec.goals || "—"}
Must-haves: ${spec.must_haves || "—"}
Avoid: ${spec.avoid || "—"}
Contact: ${it.contact_name || "—"} <${it.contact_email || "—"}> ${it.contact_phone || ""}
Service area: ${(it.about || {}).service_area || "—"}

Write, in markdown, for Daniel (the owner):
1. **Fit & qualification** — one or two sentences: good fit? which package?
2. **Suggested scope / deposit** — one sentence.
3. **Gaps / questions to ask before quoting** — a few bullets.
4. **Red flags** — bullets, or "None".
5. **Draft reply to the client** — a short, warm, specific email Daniel can send: greet ${it.contact_name || "them"} by first name, reference ${it.business_name || "their business"} specifically, say you've reviewed the brief, what you recommend, and that the next step is you'll send their quote / book a kickoff. Sign off as Daniel, ${studio} by Lost Pines Creative. Keep it human and concise. Do not invent facts not in the brief.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) { console.error("anthropic non-2xx", res.status, await res.text().catch(() => "")); return ""; }
  const d = await res.json();
  return (d?.content?.[0]?.text ?? "").toString();
}

/* ---- emails ---- */
async function sendEmail(to: string[], subject: string, html: string, replyTo?: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!res.ok) console.error("resend non-200", res.status, await res.text().catch(() => ""));
}
function ackHtml(studio: string, firstName: string, biz: string): string {
  return `<div style="font-family:Arial,sans-serif;background:#0a0e17;color:#e2e8f0;padding:28px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table width="480" cellpadding="0" cellspacing="0" style="background:#111827;border:1px solid #1e293b;border-radius:14px;overflow:hidden">
    <tr><td style="background:linear-gradient(135deg,#4a9e7e,#3ba5a1);padding:20px 26px">
      <span style="color:#fff;font-size:19px;font-weight:bold;letter-spacing:.5px">${esc(studio)}</span></td></tr>
    <tr><td style="padding:26px">
      <p style="color:#e2e8f0;font-size:16px;margin:0 0 14px">Hi ${esc(firstName)} — we've got it.</p>
      <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 14px">
        Thanks for sending your project brief for <strong style="color:#e2e8f0">${esc(biz)}</strong>.
        Here's what happens next:</p>
      <ol style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 16px;padding-left:20px">
        <li>Daniel reviews your brief and confirms the scope.</li>
        <li>You get your exact quote — no surprises.</li>
        <li>Once you approve it, you sign and pay your deposit right in your portal, and we start.</li>
      </ol>
      <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0">
        You'll usually hear back within a business day. Questions any time:
        <a href="mailto:${esc(OWNER_EMAIL)}" style="color:#5ec2a0">${esc(OWNER_EMAIL)}</a>.</p>
    </td></tr>
    <tr><td style="padding:16px 26px;border-top:1px solid #1e293b">
      <span style="color:#475569;font-size:12px">${esc(studio)} · a Lost Pines Creative studio · Bastrop, Texas</span></td></tr>
    </table></td></tr></table></div>`;
}
function ownerHtml(studio: string, it: Record<string, any>, review: string): string {
  const reviewBlock = review
    ? `<div style="background:#0a0e17;border:1px solid #1e293b;border-radius:10px;padding:16px;font-size:14px;color:#cbd5e1;line-height:1.6">${mdLite(review)}</div>`
    : `<p style="color:#94a3b8;font-size:13px">(AI review unavailable — set ANTHROPIC_API_KEY to enable. The brief is in the admin.)</p>`;
  return `<div style="font-family:Arial,sans-serif;background:#0a0e17;color:#e2e8f0;padding:24px">
    <h2 style="color:#fff;margin:0 0 6px">New brief: ${esc(String(it.business_name || "onboarding"))}</h2>
    <p style="color:#94a3b8;font-size:13px;margin:0 0 4px">${esc(String(it.contact_name || ""))} · ${esc(String(it.contact_email || ""))} · ${esc(String(it.contact_phone || ""))}</p>
    <p style="color:#94a3b8;font-size:13px;margin:0 0 16px">Requested: ${esc(String(it.package || "—"))} · care ${esc(String(it.care_plan || "none"))}</p>
    ${reviewBlock}
    <p style="margin:18px 0 0"><a href="${ADMIN_URL}" style="display:inline-block;background:#4a9e7e;color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:bold">Open in admin — set deposit &amp; accept →</a></p>
    <p style="color:#64748b;font-size:12px;margin-top:14px">The prospect already got an automatic acknowledgement. The draft reply above is for YOU to review and send (reply-to is set to the client, so hitting reply reaches them).</p>
  </div>`;
}

async function getRows(url: string): Promise<Array<Record<string, unknown>>> {
  try {
    const r = await fetch(url, { headers: svc });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}
