// ============================================================
// Onboarding — onb-lookup (Supabase Edge Function)
//
// Business autocomplete/autofill for the wizard's "About your business" step,
// backed by the Google Places API (New). The Google key stays server-side; the
// browser only ever talks to this function.
//
//   action:"autocomplete" { query, session }  → [{ place_id, main, secondary }]
//   action:"details"      { place_id, session } → normalized business fields
//
// Deploy with Verify JWT ON. It ALSO re-verifies the caller via /auth/v1/user
// (the anon key passes platform verify_jwt but is not a real user) + a per-user
// rate cap, so the Google key can't be drained by anonymous/abusive callers.
// ALWAYS also set a daily quota cap on the key in Google Cloud (the real backstop).
// Secret: GOOGLE_PLACES_API_KEY. Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// ============================================================
const KEY = Deno.env.get("GOOGLE_PLACES_API_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AUTH = `${SB_URL}/auth/v1`;

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://lostpinescreative.com,https://www.lostpinescreative.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Crude best-effort per-user rate cap (in-memory; resets on cold start / differs
// per instance — the AUTHORITATIVE backstop is the Google-side daily quota cap,
// see README). Stops a single account hammering a warm instance.
const RL = new Map<string, number[]>();
function rateOk(uid: string, max = 40, windowMs = 60000): boolean {
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

// A Google Places session token groups an autocomplete series + its details
// call into ONE billable session. The client passes a UUID; keep it plausible.
const SESSION_RE = /^[\w-]{8,64}$/;

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const c = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, c);
  if (c["Access-Control-Allow-Origin"] === DENY_ORIGIN) return json({ error: "origin not allowed" }, 403, c);
  if (!KEY) return json({ error: "lookup not configured" }, 503, c);

  // Re-verify the caller resolves to a REAL user. Platform "Verify JWT ON" alone
  // is NOT enough: the public anon key is a valid project JWT and would pass it,
  // letting anyone burn the Google budget. /auth/v1/user rejects the anon token
  // (it has no user). Same guard every other function in this module uses.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "not signed in" }, 401, c);
  const uRes = await fetch(`${AUTH}/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!uRes.ok) return json({ error: "not signed in" }, 401, c);
  const caller = await uRes.json();
  const callerId: string = caller?.id;
  if (!callerId) return json({ error: "not signed in" }, 401, c);
  if (!rateOk(callerId)) return json({ error: "too many lookups — please slow down" }, 429, c);

  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");
  const session = String(body?.session ?? "");
  const sessionOk = SESSION_RE.test(session) ? session : undefined;

  try {
    if (action === "autocomplete") {
      const query = String(body?.query ?? "").trim().slice(0, 200);
      if (query.length < 3) return json({ suggestions: [] }, 200, c);
      const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY },
        body: JSON.stringify({
          input: query,
          ...(sessionOk ? { sessionToken: sessionOk } : {}),
          includedRegionCodes: ["us"],
        }),
      });
      const d = await r.json();
      if (!r.ok) { console.error("places autocomplete", r.status, JSON.stringify(d)); return json({ suggestions: [] }, 200, c); }
      const suggestions = (d.suggestions ?? [])
        .map((s: Record<string, any>) => s.placePrediction)
        .filter(Boolean)
        .map((p: Record<string, any>) => ({
          place_id: p.placeId,
          main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
          secondary: p.structuredFormat?.secondaryText?.text ?? "",
        }))
        .slice(0, 6);
      return json({ suggestions }, 200, c);
    }

    if (action === "details") {
      const placeId = String(body?.place_id ?? "").trim();
      if (!/^[\w-]{6,256}$/.test(placeId)) return json({ error: "invalid place" }, 400, c);
      const fields = [
        "id", "displayName", "formattedAddress", "internationalPhoneNumber",
        "nationalPhoneNumber", "websiteUri", "regularOpeningHours.weekdayDescriptions",
        "primaryTypeDisplayName", "location",
      ].join(",");
      const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}` +
        (sessionOk ? `?sessionToken=${encodeURIComponent(sessionOk)}` : "");
      const r = await fetch(url, {
        headers: { "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": fields },
      });
      const d = await r.json();
      if (!r.ok) { console.error("places details", r.status, JSON.stringify(d)); return json({ error: "lookup failed" }, 502, c); }
      const hours = Array.isArray(d.regularOpeningHours?.weekdayDescriptions)
        ? d.regularOpeningHours.weekdayDescriptions.join("; ") : "";
      return json({
        place: {
          place_id: d.id ?? placeId,
          business_name: d.displayName?.text ?? "",
          industry: d.primaryTypeDisplayName?.text ?? "",
          address: d.formattedAddress ?? "",
          phone: d.nationalPhoneNumber ?? d.internationalPhoneNumber ?? "",
          website: d.websiteUri ?? "",
          hours,
          lat: d.location?.latitude ?? null,
          lng: d.location?.longitude ?? null,
        },
      }, 200, c);
    }

    return json({ error: "unknown action" }, 400, c);
  } catch (e) {
    console.error("onb-lookup threw", e);
    return json({ error: "lookup error" }, 502, c);
  }
});
