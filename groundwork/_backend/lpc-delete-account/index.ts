// ============================================================
// Lost Pines — lpc-delete-account (Supabase Edge Function)
//
// "Delete my account" in the Lost Pines app (Apple 5.1.1(v)) and on
// lostpinescreative.com/delete-account.html. Starts and finishes here:
//   1) Authenticates the caller from their JWT; requires {confirm: "DELETE"}.
//   2) lpc_delete_account_data() (010) in one transaction: detaches Groundwork
//      businesses (kept for the studio) and revokes phones, deletes the
//      user's own DeSmit projects, removes shares, queues project files.
//   3) Removes the queued files from Storage (failures stay queued and logged;
//      they never block the deletion).
//   4) Deletes the auth user (profile, requests and session go with it).
//   5) Emails the studio which businesses were detached (best effort).
// Each step is idempotent: a failed run returns 503 and running it again
// finishes. Studio admin accounts are refused.
//
// Deploy with Verify JWT ON. Secrets: RESEND_API_KEY (optional here),
// STUDIO_NOTIFY_EMAIL, INVITE_FROM. Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// ============================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("INVITE_FROM") ?? "Lost Pines Creative <noreply@lostpinescreative.com>";
const TO = Deno.env.get("STUDIO_NOTIFY_EMAIL") ?? "ddesmit@lostpinescreative.com";
const T_EXT = 8000;

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://lostpinescreative.com,https://www.lostpinescreative.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const REST = `${SB_URL}/rest/v1`;
const svc = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fetchT(url: string, opts: RequestInit, ms = T_EXT): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}

// Browsers must be on the allow-list; the native app sends no Origin.
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

type Intake = { business_name: string | null; pay_status: string | null; stripe_subscription_id: string | null };
type Deleted = { detached_clients: string[]; deleted_projects: number; detached_intakes?: Intake[] };

// Remove queued Storage objects; clear a bucket's queue only once Storage accepted all of it.
async function purgeFiles(userId: string): Promise<number> {
  const q = await fetchT(`${REST}/lpc_storage_purge?select=bucket,path&deleted_user_id=eq.${userId}`, { headers: svc });
  if (!q.ok) { console.error("purge queue read failed", q.status); return 0; }
  const rows = await q.json() as Array<{ bucket: string; path: string }>;
  const byBucket = new Map<string, string[]>();
  for (const r of rows) byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), r.path]);
  let removed = 0;
  for (const [bucket, paths] of byBucket) {
    const del = await fetchT(`${SB_URL}/storage/v1/object/${encodeURIComponent(bucket)}`, {
      method: "DELETE", headers: svc, body: JSON.stringify({ prefixes: paths }),
    }).catch(() => null);
    if (!del?.ok) { console.error("storage delete failed", bucket, del?.status); continue; }
    // By user + bucket, not a path list: a long in.(…) list can exceed URL limits.
    await fetchT(`${REST}/lpc_storage_purge?bucket=eq.${encodeURIComponent(bucket)}` +
      `&deleted_user_id=eq.${userId}`, { method: "DELETE", headers: svc }).catch(() => null);
    removed += paths.length;
  }
  return removed;
}

async function tellStudio(email: string, detached: string[], projects: number, intakes: Intake[]): Promise<void> {
  if (!RESEND_KEY) return;
  const subs = intakes.length
    ? "<p><b>Onboarding records kept (detached from the login):</b></p><ul>" + intakes.map((i) =>
      `<li>${escapeHtml(i.business_name ?? "(no name)")} — payment: ${escapeHtml(i.pay_status ?? "unknown")}` +
      (i.stripe_subscription_id
        ? ` — <b>Stripe subscription ${escapeHtml(i.stripe_subscription_id)} is still active until you cancel it</b>`
        : "") + "</li>").join("") + "</ul>"
    : "";
  const list = detached.length
    ? `<ul>${detached.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>` +
      "<p>These Groundwork businesses are kept but no longer have an owner login. Close them out or re-invite an owner.</p>"
    : "<p>No Groundwork businesses were attached.</p>";
  await fetchT("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to: [TO], subject: "A customer deleted their Lost Pines account",
      html: `<p><b>${escapeHtml(email)}</b> deleted their account.</p>${list}` +
        `${subs}<p>DeSmit Designs projects deleted: ${projects}.</p>`,
    }),
  }).catch((e) => console.error("studio email failed", String(e)));
}

Deno.serve(async (req) => {
  const c = cors(req.headers.get("origin"));
  if (!c) return json({ error: "origin not allowed" }, 403);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, c);

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "not signed in" }, 401, c);
    const uRes = await fetchT(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
    if (uRes.status === 401 || uRes.status === 403) return json({ error: "not signed in" }, 401, c);
    if (!uRes.ok) throw new Error(`auth ${uRes.status}`);
    const user = await uRes.json();
    const userId = String(user?.id ?? "");
    if (!UUID.test(userId)) return json({ error: "not signed in" }, 401, c);

    const body = await req.json().catch(() => null);
    if (body?.confirm !== "DELETE") return json({ error: 'type DELETE to confirm', code: "confirm_required" }, 400, c);

    const rpc = await fetchT(`${REST}/rpc/lpc_delete_account_data`, {
      method: "POST", headers: svc, body: JSON.stringify({ p_user: userId }),
    });
    if (!rpc.ok) {
      // Only the function's own refusal (SQLSTATE 42501) means "admin account";
      // any other failure (e.g. a missing grant) must not be reported as that.
      const err = await rpc.json().catch(() => ({})) as { code?: string };
      if (err.code === "42501") {
        return json({ error: "studio admin accounts can't be deleted here", code: "admin_account" }, 403, c);
      }
      throw new Error(`data ${rpc.status}`);
    }
    const result = await rpc.json() as Deleted;

    const filesRemoved = await purgeFiles(userId);

    const del = await fetchT(`${SB_URL}/auth/v1/admin/users/${userId}`, { method: "DELETE", headers: svc });
    if (!del.ok && del.status !== 404) throw new Error(`auth delete ${del.status}`);

    await tellStudio(String(user?.email ?? userId), result.detached_clients ?? [], result.deleted_projects ?? 0,
      result.detached_intakes ?? []);
    console.log(JSON.stringify({ evt: "account_deleted", detached: result.detached_clients?.length ?? 0,
      projects: result.deleted_projects ?? 0, files: filesRemoved }));
    return json({ ok: true }, 200, c);
  } catch (e) {
    console.error("delete-account error", String(e));
    return json({ error: "couldn't finish — please try again", code: "retry" }, 503, c);
  }
});
