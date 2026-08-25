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
// Deploy with Verify JWT ON (only signed-in wizard users may call it — protects
// the Google key from abuse/cost). Secret: GOOGLE_PLACES_API_KEY.
// ============================================================
const KEY = Deno.env.get("GOOGLE_PLACES_API_KEY") ?? "";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://lostpinescreative.com,https://www.lostpinescreative.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

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
