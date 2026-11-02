// ============================================================
// Groundwork — ring-first voice webhook (Supabase Edge Function)
//
// Voice URL of a line's published number. Rings the owner's cell first and
// sends anything they don't accept to the line's AI number, where gw-reception
// takes over. Deploy with JWT verification OFF: every request is checked
// against Twilio's signature instead, and fails closed.
//
// Secrets: TWILIO_AUTH_TOKEN (plus the SUPABASE_* the platform provides)
// ============================================================
import { accept, after, e164, hangup, inbound, type Route, signatureOk, whisper } from "./twiml.ts";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TW_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const FN_URL = `${SB_URL}/functions/v1/gw-ring`;

const xml = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/xml" } });
// Metadata only: never log phone numbers.
const trace = (o: Record<string, unknown>) => console.log(JSON.stringify({ evt: "agent_run", fn: "gw-ring", ...o }));

async function loadRoute(publicNumber: string): Promise<Route | null> {
  const sel = "ai_number,owner_alert_number,client:gw_clients(settings:gw_settings(forward_number))";
  const r = await fetch(
    `${SB_URL}/rest/v1/gw_reception_lines?select=${sel}&public_number=eq.${encodeURIComponent(publicNumber)}&limit=1`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, signal: AbortSignal.timeout(4000) },
  );
  if (!r.ok) throw new Error(`lookup ${r.status}`);
  const row = (await r.json())[0];
  const aiNumber = e164(row?.ai_number);
  if (!aiNumber) return null;
  const settings = row.client?.settings;
  const forward = Array.isArray(settings) ? settings[0]?.forward_number : settings?.forward_number;
  const digits = String(row.owner_alert_number ?? forward ?? "").replace(/\D/g, "");
  const cell = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits[0] === "1" ? `+${digits}` : null;
  return { publicNumber, aiNumber, cell };
}

const SORRY = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, we can't take your call right now. Please try again shortly.</Say></Response>`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const query = new URL(req.url).search;
  const params = new URLSearchParams(await req.text());
  const ok = await signatureOk(TW_TOKEN, `${FN_URL}${query}`, params, req.headers.get("x-twilio-signature") ?? "");
  if (!ok) {
    trace({ outcome: "bad_signature" });
    return xml(hangup(), 403);
  }
  const q = new URLSearchParams(query);
  const step = q.get("step") ?? "inbound";
  try {
    if (step === "whisper") return xml(whisper(FN_URL, q.get("c")));
    if (step === "accept") return xml(accept(params.get("Digits")));
    // `To` on these parent-leg requests is the published number.
    const route = await loadRoute(e164(params.get("To")) ?? "");
    if (!route) {
      trace({ step, outcome: "no_line" });
      return xml(SORRY);
    }
    trace({ step, outcome: "ok", cell: !!route.cell, bridged: params.get("DialBridged") });
    if (step === "after") return xml(after(route, params.get("DialBridged"), params.get("From")));
    return xml(inbound(route, FN_URL, params.get("From"), params.get("ForwardedFrom")));
  } catch (e) {
    console.error("gw-ring error", step, String(e));
    return xml(SORRY);
  }
});
