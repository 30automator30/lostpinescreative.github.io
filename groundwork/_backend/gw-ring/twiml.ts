// TwiML for ring-first calls. Pure functions so gw-ring.test.ts can run them.
//
//   inbound  -> ring the owner's cell, showing the business number as caller ID
//   whisper  -> tell the owner who is calling; press 1 to accept
//   accept   -> 1 connects the call, anything else drops the owner's leg
//   after    -> not connected (declined, no answer, voicemail) -> the AI line

export const RING_SECONDS = 20;

export type Route = { publicNumber: string; aiNumber: string; cell: string | null };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const doc = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

export const hangup = () => doc("<Hangup/>");

// https://www.twilio.com/docs/usage/webhooks/webhooks-security
export async function signatureOk(token: string, url: string, params: URLSearchParams, sig: string): Promise<boolean> {
  if (!token || !sig) return false;
  let data = url;
  for (const k of [...new Set(params.keys())].sort()) for (const v of params.getAll(k)) data += k + v;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  const want = btoa(String.fromCharCode(...mac));
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export function e164(raw: string | null): string | null {
  const s = (raw ?? "").trim();
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

// The AI line needs the customer's number for its logs and text-backs. A hidden
// caller has none, so fall back to the business number.
function toAi(r: Route, from: string | null): string {
  return doc(`<Dial answerOnBridge="true" callerId="${esc(from ?? r.publicNumber)}"><Number>${esc(r.aiNumber)}</Number></Dial>`);
}

export function inbound(r: Route, fnUrl: string, rawFrom: string | null, forwardedFrom: string | null): string {
  const from = e164(rawFrom);
  // No cell to ring, the owner calling their own line, or a call their carrier
  // forwarded back here (it arrives showing the business number): ringing the
  // cell again would loop.
  if (!r.cell || from === r.cell || from === r.publicNumber || e164(forwardedFrom) === r.cell) return toAi(r, from);
  const c = from ? `&c=${encodeURIComponent(from)}` : "";
  return doc(
    `<Dial answerOnBridge="true" callerId="${esc(r.publicNumber)}" timeout="${RING_SECONDS}" action="${esc(`${fnUrl}?step=after`)}">` +
      `<Number url="${esc(`${fnUrl}?step=whisper${c}`)}">${esc(r.cell)}</Number></Dial>`,
  );
}

export function whisper(fnUrl: string, customer: string | null): string {
  const c = e164(customer);
  const who = c ? c.replace(/^\+1/, "").replace(/\D/g, "").split("").join(" ") : "an unknown number";
  // No key press (voicemail, a pocket answer) falls through to the hang-up.
  return doc(
    `<Gather numDigits="1" timeout="6" action="${esc(`${fnUrl}?step=accept`)}">` +
      `<Say>Business call from ${esc(who)}. Press 1 to accept.</Say></Gather><Hangup/>`,
  );
}

export const accept = (digits: string | null) => (digits === "1" ? doc("") : hangup());

export function after(r: Route, dialBridged: string | null, rawFrom: string | null): string {
  return dialBridged === "true" ? hangup() : toAi(r, e164(rawFrom));
}
