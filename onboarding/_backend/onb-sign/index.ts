// ============================================================
// Onboarding — onb-sign (Supabase Edge Function)
//
// Records a click-through electronic signature (U.S. E-SIGN Act) on the
// services agreement for an onboarding intake, then emails a copy.
//
//   1) Authenticate the caller from their JWT.
//   2) Confirm the intake is theirs (or they're admin).
//   3) Hash the exact agreement text, capture name + timestamp + IP + UA,
//      write the proof onto onb_intakes, log an onb_events row.
//   4) Email a copy of the signed agreement to the client (best-effort).
//
// Deploy with Verify JWT ON (only signed-in clients may sign).
// Secrets: RESEND_API_KEY (optional). Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// ============================================================
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("INVITE_FROM") ?? "Lost Pines Creative <noreply@lostpinescreative.com>";
const OWNER_EMAIL = Deno.env.get("OWNER_EMAIL") ?? "desmitdesignz@gmail.com";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://lostpinescreative.com,https://www.lostpinescreative.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const REST = `${SB_URL}/rest/v1`;
const AUTH = `${SB_URL}/auth/v1`;
const svc = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Current agreement version — bump when AGREEMENT_TEXT below changes materially.
// Must stay in step with config.js AGREEMENT_VERSION and app.js buildAgreementText.
const AGREEMENT_VERSION = "msa-v1";
const STUDIO = { desmit: { name: "DeSmit Designs", email: "desmitdesignz@gmail.com" },
                 groundwork: { name: "Groundwork", email: "desmitdesignz@gmail.com" } };
const PKG_LABEL: Record<string, string> = {
  starter: "Starter", foundation: "Foundation", growth: "Growth", full_build: "Full Build", custom: "Not sure yet",
};
const CARE: Record<string, { label: string; amt: number | null }> = {
  none: { label: "None", amt: 0 }, essential: { label: "Essential — maintainer", amt: 99 },
  growth: { label: "Growth — active operator", amt: 300 }, partner: { label: "Partner — digital-ops partner", amt: null },
};

// Sentinel for a disallowed origin — NOT the literal "null" (browsers treat
// ACAO:"null" as a match for an `Origin: null` sandboxed/data: caller).
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

// Canonical services agreement — generated SERVER-SIDE from the intake so the
// stored text + hash attest to the STUDIO's terms, not whatever the browser
// sent. Mirrors app.js buildAgreementText(); keep the two in sync and bump
// AGREEMENT_VERSION when the wording changes.
function buildAgreement(it: Record<string, string>): string {
  const s = STUDIO[(it.product as "desmit" | "groundwork")] ?? STUDIO.groundwork;
  const pkg = PKG_LABEL[it.package] ?? "the agreed build";
  const careRow = CARE[it.care_plan] ?? { label: "None", amt: 0 };
  const annual = it.billing_cycle === "annual";
  const cycleWord = annual ? "annually" : "monthly";
  const careLine = it.care_plan && it.care_plan !== "none"
    ? (careRow.amt ? `${careRow.label} at $${annual ? careRow.amt * 10 : careRow.amt}/${annual ? "yr" : "mo"}, billed ${cycleWord}`
                   : `${careRow.label} (billed on an agreed custom retainer)`)
    : "None selected";
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const client = it.business_name || it.contact_name || it.contact_email || "Client";
  return `SERVICES AGREEMENT — ${s.name} (a studio of Lost Pines Creative LLC)
Version ${AGREEMENT_VERSION} · Prepared ${today}

CLIENT: ${client}
CONTACT: ${it.contact_name || ""} — ${it.contact_email || ""}
STUDIO: Lost Pines Creative LLC (d/b/a ${s.name}), Bastrop, Texas

This agreement is between the Client and the Studio for the project described in
the Client's onboarding brief (the "Spec"), which is incorporated by reference.

1. SCOPE. The Studio will deliver the selected build — ${pkg} — as detailed in the
   Spec. Items the Client marked "let the designer decide" are left to the Studio's
   reasonable professional judgment. Work materially beyond the Spec is a change
   (see §6) and will be quoted separately before it is done.

2. FEES, DEPOSIT & PAYMENT. Work begins after the deposit is received. Unless a
   written quote says otherwise, the deposit is 50% of the project total and is
   applied to that total; the remaining balance is due on delivery/launch. Larger
   or scoped builds (e.g. Full Build) may instead be billed against a written
   milestone schedule. Invoices are due on receipt; balances unpaid 14 days past
   due may pause work. Prices are in U.S. dollars.

3. THIRD-PARTY COSTS — AT COST, NEVER MARKED UP. Domains, hosting, software,
   telephony, AI usage, and any other third-party services are the Client's own
   accounts and are billed to the Client at actual cost with no markup, itemized.
   The Client is responsible for these ongoing costs.

4. OWNERSHIP — YOU OWN EVERYTHING, ALWAYS. Every account created for the project is
   created in the Client's name; the Client owns those accounts and all of their
   data at all times. On full payment for the build, the Client also owns the
   delivered work product. During any active Care plan the Studio holds admin/
   manager access to operate and maintain the systems; on offboarding the Studio
   transfers full ownership, removes its own access, and delivers final exports and
   the "Your System" runbook. No hostage data, no lock-in. The Studio may display
   non-confidential work in its portfolio unless the Client opts out in writing.

5. CARE PLAN (ongoing). Selected plan: ${careLine}. Care plans are recurring and
   continue until cancelled. Either party may cancel with notice, effective at the
   end of the current paid period; the current period is non-refundable. Third-
   party usage under the plan is billed at cost per §3. Plan scope is per the
   published Care tiers; work beyond the tier is quoted as a mini-project.

6. REVISIONS, CLIENT RESPONSIBILITIES & TIMELINE. Reasonable revisions within the
   agreed Spec are included. The Client agrees to provide content, approvals, and
   account access promptly; timelines and delivery dates assume this and shift if
   the Client's inputs are delayed. Substantial new requests are quoted separately.

7. CANCELLATION. Either party may cancel the build with written notice. Fees for
   work completed to the cancellation date are earned and non-refundable, and the
   deposit covers initial work; any unused prepaid amount for work not yet started
   is refunded.

8. WARRANTY & LIABILITY. The Studio provides the services on a commercially
   reasonable-efforts basis and does not guarantee specific business outcomes
   (e.g. rankings, revenue, or call volume). To the extent permitted by law, the
   Studio's total liability under this agreement is limited to the fees the Client
   paid for the build, and neither party is liable for indirect or consequential
   damages. The Client is responsible for the lawful use of any messaging/review-
   request features (including applicable consent/TCPA requirements).

9. INDEPENDENT CONTRACTOR & CONFIDENTIALITY. The Studio is an independent
   contractor, not an employee or partner of the Client. Each party will keep the
   other's non-public information confidential and use it only to perform this
   agreement.

10. ELECTRONIC SIGNATURE. By typing your full legal name and checking the box, you
    agree this constitutes your electronic signature under the U.S. E-SIGN Act,
    that you have authority to bind the Client, and that you have read and accept
    this agreement and the attached Spec.

Governing law: State of Texas. Questions: ${s.email}.`;
}
const json = (o: unknown, s: number, c: Record<string, string>) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...c } });

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
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
  const signedName = String(body?.signed_name ?? "").trim();
  if (!UUID_RE.test(intakeId)) return json({ error: "invalid intake" }, 400, c);
  if (signedName.length < 2 || signedName.length > 200) return json({ error: "please type your full legal name" }, 400, c);

  // Fetch the intake with everything the canonical agreement needs; confirm the
  // caller owns it (or is admin).
  const rows = await getRows(`${REST}/onb_intakes?id=eq.${intakeId}&select=id,owner_id,status,sign_status,contact_email,contact_name,business_name,package,care_plan,billing_cycle,product`);
  if (!rows.length) return json({ error: "intake not found" }, 404, c);
  const intake = rows[0] as Record<string, string>;
  if (intake.owner_id !== callerId) {
    const adm = await getRows(`${REST}/dd_profiles?id=eq.${callerId}&is_admin=eq.true&select=id`);
    if (!adm.length) return json({ error: "not allowed" }, 403, c);
  }
  // Quote-first gate, enforced server-side: no signing before the studio accepts.
  if (intake.status !== "accepted") {
    return json({ error: "This brief hasn't been approved yet — the studio will send your quote first." }, 409, c);
  }
  // Write-once: never overwrite an executed signature (fast pre-check; the PATCH
  // below is also filtered on sign_status='unsigned' to close the race).
  if (intake.sign_status === "signed") {
    return json({ error: "This agreement is already signed." }, 409, c);
  }

  // Generate the agreement text SERVER-SIDE (ignore anything the client sent) and
  // hash THAT — the record attests to the studio's terms, not the browser's.
  const text = buildAgreement(intake);
  const hash = await sha256(text);
  // Record the FULL X-Forwarded-For chain (the platform appends the real client
  // IP as the last hop; the leftmost token is client-supplied and untrusted).
  const ip = (req.headers.get("x-forwarded-for") ?? "").trim().slice(0, 300) || null;
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 400) || null;
  const now = new Date().toISOString();

  // Atomic write-once: only update while still unsigned; return the row so we can
  // tell whether we actually won.
  const upd = await fetch(`${REST}/onb_intakes?id=eq.${intakeId}&sign_status=eq.unsigned`, {
    method: "PATCH", headers: { ...svc, Prefer: "return=representation" },
    body: JSON.stringify({
      sign_status: "signed", signed_name: signedName, signed_at: now,
      signed_ip: ip, signed_user_agent: ua,
      agreement_version: AGREEMENT_VERSION, agreement_hash: hash, agreement_snapshot: text,
    }),
  });
  if (!upd.ok) { console.error("sign patch failed", await upd.text()); return json({ error: "couldn't record signature" }, 502, c); }
  const updated = await upd.json().catch(() => []);
  if (!Array.isArray(updated) || !updated.length) {
    return json({ error: "This agreement is already signed." }, 409, c); // lost the race
  }
  const version = AGREEMENT_VERSION;

  await fetch(`${REST}/onb_events`, {
    method: "POST", headers: { ...svc, Prefer: "return=minimal" },
    body: JSON.stringify({ intake_id: intakeId, actor_id: callerId, kind: "signed",
      detail: { name: signedName, version, hash, ip } }),
  }).catch(() => {});

  // email a copy (best-effort)
  if (RESEND_KEY) {
    const to = [intake.contact_email || caller?.email, OWNER_EMAIL].filter(Boolean) as string[];
    await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM, to,
        subject: `Signed services agreement — ${intake.business_name || "your project"}`,
        html: `<div style="font-family:Arial,sans-serif;background:#0a0e17;color:#e2e8f0;padding:24px">
          <p>Signed by <b>${escapeHtml(signedName)}</b> on ${escapeHtml(now)}.</p>
          <p style="color:#94a3b8;font-size:12px">Version ${escapeHtml(version)} · SHA-256 ${escapeHtml(hash)}</p>
          <pre style="white-space:pre-wrap;background:#111827;border:1px solid #1e293b;border-radius:10px;padding:16px;font-size:12px;color:#cbd5e1">${escapeHtml(text)}</pre>
        </div>`,
      }),
    }).catch((e) => console.error("resend failed", e));
  }

  return json({ ok: true, signed_at: now, hash, agreement_text: text }, 200, c);
});

async function getRows(url: string): Promise<Array<Record<string, unknown>>> {
  try {
    const r = await fetch(url, { headers: svc });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}
