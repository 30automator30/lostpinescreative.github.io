// Behaviour tests for gw-reception — fakes PostgREST, Cal.com and Twilio.
// Run: deno test -A groundwork/_backend/gw-reception/index.test.ts
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "https://proj.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "srk");
Deno.env.set("VAPI_SERVER_SECRET", "s3cret");
Deno.env.set("VAPI_CREDENTIAL_ID", "cred_1");
Deno.env.set("TWILIO_ACCOUNT_SID", "AC1");
Deno.env.set("TWILIO_AUTH_TOKEN", "twtok");
Deno.env.set("CALCOM_API_KEY", "calkey");

// ---------- fake state ----------
const CLIENT = "c-1";
const line = {
  client_id: CLIENT, vapi_phone_number_id: "pn_1", ai_number: "+15125550100",
  owner_alert_number: null, cal_event_type_id: 42, booking_url: "https://cal.com/desmit",
  timezone: "America/Chicago", voice_id: null, enabled: true,
  client: { business_name: "DeSmit Designs", status: "active",
    settings: { greeting: null, forward_number: "(408) 348-7284", textback_message: null,
      hours: { text: "Mon–Fri 8–5" }, after_hours: null, knowledge: "3D printing and laser cutting." } },
};
let messages: Array<Record<string, unknown>> = [];
let sms: Array<{ To: string; Body: string; From: string | null }> = [];
let calBookings: Array<Record<string, unknown>> = [];
let aiEnabled = true;

const future = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const SLOT1 = future(24), SLOT2 = future(26);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const ok = (b: unknown, h: Record<string, string> = {}) =>
    new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json", ...h } });

  if (url.host === "proj.supabase.co") {
    const table = url.pathname.replace("/rest/v1/", "");
    if (table === "ai_config") return ok([{ enabled: aiEnabled }]);
    if (table === "ai_call_log") return method === "GET" ? ok([], { "content-range": "0-0/3" }) : ok([]);
    if (table === "gw_reception_lines") {
      const or = url.searchParams.get("or") ?? "";
      const hit = or.includes("pn_1") || or.includes("+15125550100");
      return ok(hit ? [line] : []);
    }
    if (table === "gw_messages") {
      if (method === "GET") {
        const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "");
        if (new Headers(init?.headers).get("Prefer")?.includes("count=exact")) {
          const n = messages.filter((m) =>
            (!eq("kind") || m.kind === eq("kind")) &&
            (!eq("from_phone") || m.from_phone === eq("from_phone")) &&
            (!eq("meta->>channel") || (m.meta as Record<string, unknown>)?.channel === eq("meta->>channel"))
          ).length;
          return ok([], { "content-range": `0-0/${n}` });
        }
        return ok(messages.filter((m) => m.external_id === eq("external_id")));
      }
      const row = JSON.parse(String(init!.body));
      const prefer = new Headers(init!.headers).get("Prefer") ?? "";
      const i = messages.findIndex((m) => m.external_id === row.external_id);
      if (i >= 0) {
        if (prefer.includes("ignore-duplicates")) return ok([]);
        messages[i] = { ...messages[i], ...row };
        return ok([messages[i]]);
      }
      messages.push({ status: "new", ...row });
      return ok([row]);
    }
  }
  if (url.host === "api.cal.com") {
    if (url.pathname === "/v2/slots") {
      const d1 = SLOT1.slice(0, 10), d2 = SLOT2.slice(0, 10);
      const data: Record<string, unknown[]> = {};
      (data[d1] ??= []).push({ start: SLOT1 });
      (data[d2] ??= []).push({ start: SLOT2 });
      return ok({ status: "success", data });
    }
    if (url.pathname === "/v2/bookings") {
      assertEquals(new Headers(init!.headers).get("cal-api-version"), "2024-08-13");
      calBookings.push(JSON.parse(String(init!.body)));
      return ok({ status: "success", data: { uid: "bk_1" } });
    }
  }
  if (url.host === "api.twilio.com") {
    const f = new URLSearchParams(String(init!.body));
    sms.push({ To: f.get("To")!, Body: f.get("Body")!, From: f.get("From") });
    return ok({ sid: "SM1" });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

// Capture the handler instead of serving.
let handler!: (r: Request) => Promise<Response>;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: typeof handler) => { handler = h; };
await import("./index.ts");

const FN = "https://proj.supabase.co/functions/v1/gw-reception";
const vapi = (message: unknown, auth = "Bearer s3cret") =>
  handler(new Request(FN, { method: "POST", headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ message }) }));
const call = (id: string, customer = "+15125551234") =>
  ({ id, phoneNumberId: "pn_1", customer: { number: customer } });
const reset = () => { messages = []; sms = []; calBookings = []; aiEnabled = true; };

Deno.test("rejects requests without the Vapi bearer", async () => {
  assertEquals((await vapi({ type: "assistant-request" }, "Bearer nope")).status, 401);
  assertEquals((await vapi({ type: "assistant-request" }, "")).status, 401);
});

Deno.test("assistant-request builds the client's receptionist with booking", async () => {
  reset();
  const r = await (await vapi({ type: "assistant-request", call: call("c1"), phoneNumber: { id: "pn_1" } })).json();
  const a = r.assistant;
  assertEquals(a.model.provider, "anthropic");
  assertMatch(a.firstMessage, /DeSmit Designs/);
  assertMatch(a.firstMessage, /AI assistant and this call may be recorded/);
  const names = a.model.tools.map((t: { function?: { name: string }; type: string }) => t.function?.name ?? t.type);
  assertEquals(names.sort(), ["book_appointment", "check_availability", "endCall", "take_message"]);
  assertMatch(a.model.messages[0].content, /3D printing and laser cutting/);
  assertMatch(a.model.messages[0].content, /\+15125551234/);
  assertEquals(a.server.credentialId, "cred_1");
});

Deno.test("unknown number and kill switch fall back (caller still hears something)", async () => {
  reset();
  let r = await (await vapi({ type: "assistant-request", call: { id: "x", phoneNumberId: "pn_other" } })).json();
  assertEquals(r.assistant.name, "Fallback desk");
  aiEnabled = false;
  r = await (await vapi({ type: "assistant-request", call: call("c2") })).json();
  assertEquals(r.assistant.name, "Fallback desk");
  assertMatch(r.assistant.firstMessage, /DeSmit Designs/);
});

Deno.test("full booked call: slots -> book -> report texts caller + owner once", async () => {
  reset();
  const tc = (name: string, args: unknown) =>
    vapi({ type: "tool-calls", call: call("c3"),
      toolCallList: [{ id: "t-" + name, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  const slots = (await (await tc("check_availability", {})).json()).results[0].result as string;
  assertMatch(slots, new RegExp(`start=${SLOT1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const booked = (await (await tc("book_appointment", { start: SLOT1, name: "Ann Lee", notes: "sign" })).json())
    .results[0].result;
  assertMatch(booked, /^Booked for/);
  assertEquals(calBookings.length, 1);
  assertEquals((calBookings[0].attendee as Record<string, string>).phoneNumber, "+15125551234");
  // retry of the same booking is idempotent
  await tc("book_appointment", { start: SLOT1, name: "Ann Lee" });
  assertEquals(calBookings.length, 1);

  const report = { type: "end-of-call-report", call: call("c3"), endedReason: "customer-ended-call",
    artifact: { messages: [{ role: "user", message: "I need a sign" }], transcript: "..." },
    analysis: { summary: "Ann wants a sign." } };
  await vapi(report);
  const row = messages.find((m) => m.external_id === "c3")!;
  assertEquals(row.kind, "lead");
  assertEquals((row.meta as Record<string, unknown>).reported, true);
  assertEquals(sms.length, 2);
  assertEquals(sms[0].To, "+15125551234");
  assertMatch(sms[0].Body, /You're booked for/);
  assertEquals(sms[0].From, "+15125550100");
  assertEquals(sms[1].To, "+14083487284");
  assertMatch(sms[1].Body, /BOOKED/);
  // Vapi retries the report: no second round of texts
  await vapi(report);
  assertEquals(sms.length, 2);
});

Deno.test("hang-up before talking = missed_call + text-back with booking link", async () => {
  reset();
  await vapi({ type: "end-of-call-report", call: call("c4"), endedReason: "customer-ended-call",
    artifact: { messages: [{ role: "assistant", message: "Thanks for calling" }] }, analysis: {} });
  const row = messages.find((m) => m.external_id === "c4")!;
  assertEquals(row.kind, "missed_call");
  assert(messages.some((m) => m.external_id === "c4:textback" && m.kind === "textback"));
  assertMatch(sms[0].Body, /Sorry we missed your call at DeSmit Designs!.*cal\.com\/desmit.*STOP/);
  assertMatch(sms[1].Body, /missed call/);
});

Deno.test("take_message keeps caller's name; no SMS to non-US numbers", async () => {
  reset();
  await vapi({ type: "tool-calls", call: call("c5", "+447700900123"),
    toolCallList: [{ id: "t1", type: "function", function: { name: "take_message",
      arguments: JSON.stringify({ name: "Bo", message: "Quote for 50 keychains", urgent: true }) } }] });
  await vapi({ type: "end-of-call-report", call: call("c5", "+447700900123"), endedReason: "assistant-ended-call",
    artifact: { messages: [{ role: "user", message: "hi" }] }, analysis: { summary: "Bo wants keychains" } });
  const row = messages.find((m) => m.external_id === "c5")!;
  assertEquals(row.from_name, "Bo");
  assertEquals(row.body, "Quote for 50 keychains");
  assertEquals(sms.length, 1); // owner alert only
  assertMatch(sms[0].Body, /^URGENT DeSmit Designs call: Bo/);
});

Deno.test("book_appointment rejects past / malformed times without calling Cal", async () => {
  reset();
  const r = await (await vapi({ type: "tool-calls", call: call("c6"),
    toolCallList: [{ id: "t1", type: "function", function: { name: "book_appointment",
      arguments: JSON.stringify({ start: "2020-01-01T10:00:00Z", name: "X" }) } }] })).json();
  assertMatch(r.results[0].result, /isn't valid/);
  assertEquals(calBookings.length, 0);
});

async function twSig(url: string, p: URLSearchParams, token: string) {
  let data = url;
  for (const k of [...new Set(p.keys())].sort()) for (const v of p.getAll(k)) data += k + v;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...mac));
}

Deno.test("inbound SMS reply: signed -> inbox + forwarded; unsigned -> 403; owner -> ignored", async () => {
  reset();
  const url = FN + "?src=twilio-sms";
  const p = new URLSearchParams({ From: "+15125551234", To: "+15125550100", Body: "Can you do Friday?", MessageSid: "SMa" });
  const send = async (sig: string, params = p) =>
    await handler(new Request(url, { method: "POST", headers: { "x-twilio-signature": sig,
      "content-type": "application/x-www-form-urlencoded" }, body: params.toString() }));
  assertEquals((await send("bad")).status, 403);
  assertEquals((await send(await twSig(url, p, "twtok"))).status, 200);
  assert(messages.some((m) => m.external_id === "sms:SMa" && m.body === "Can you do Friday?"));
  assertEquals(sms.length, 1);
  assertMatch(sms[0].Body, /text from \+15125551234: Can you do Friday\?/);
  const own = new URLSearchParams({ From: "+14083487284", To: "+15125550100", Body: "ok", MessageSid: "SMb" });
  await send(await twSig(url, own, "twtok"), own);
  assertEquals(sms.length, 1);
});

Deno.test("one text-back per number per day; Caribbean +1 numbers never texted", async () => {
  reset();
  const missed = (id: string, num: string) => vapi({ type: "end-of-call-report", call: call(id, num),
    endedReason: "customer-ended-call", artifact: { messages: [] }, analysis: {} });
  await missed("r1", "+15125551234");
  await missed("r2", "+15125551234"); // spoofed/repeat caller
  assertEquals(sms.filter((m) => m.To === "+15125551234").length, 1);
  assertEquals(sms.filter((m) => m.To === "+14083487284").length, 1); // repeat silent call: no 2nd alert
  await missed("r3", "+18095550123"); // Dominican Republic
  assertEquals(sms.filter((m) => m.To === "+18095550123").length, 0);
});

Deno.test("booking ignores caller-supplied email and non-US phone; one booking per call", async () => {
  reset();
  const book = (start: string) => vapi({ type: "tool-calls", call: call("b1"),
    toolCallList: [{ id: "t" + start, type: "function", function: { name: "book_appointment",
      arguments: JSON.stringify({ start, name: "Z", phone: "+447700900123", email: "victim@example.com" }) } }] });
  await book(SLOT1);
  const att = calBookings[0].attendee as Record<string, string>;
  assertEquals(att.phoneNumber, "+15125551234");
  assertEquals(att.email, undefined);
  const r = await (await book(SLOT2)).json();
  assertMatch(r.results[0].result, /One booking per call/);
  assertEquals(calBookings.length, 1);
});

Deno.test("replayed SMS webhook forwards to owner only once", async () => {
  reset();
  const url = FN + "?src=twilio-sms";
  const p = new URLSearchParams({ From: "+15125559999", To: "+15125550100", Body: "hi", MessageSid: "SMr" });
  const sig = await twSig(url, p, "twtok");
  for (let i = 0; i < 3; i++) {
    await handler(new Request(url, { method: "POST", headers: { "x-twilio-signature": sig,
      "content-type": "application/x-www-form-urlencoded" }, body: p.toString() }));
  }
  assertEquals(sms.length, 1);
});

globalThis.addEventListener("unload", () => { globalThis.fetch = realFetch; });
