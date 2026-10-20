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
Deno.env.set("RESEND_API_KEY", "re_test");
Deno.env.set("RL_EMAIL_DAY", "3");

// ---------- fake state ----------
const CLIENT = "c-1";
const line = {
  client_id: CLIENT, vapi_phone_number_id: "pn_1", ai_number: "+15125550100",
  owner_alert_number: null, cal_event_type_id: 42, booking_url: "https://cal.com/desmit",
  timezone: "America/Chicago", voice_id: null, enabled: true, texting_enabled: true,
  client: { business_name: "DeSmit Designs", status: "active", owner_id: "u-1" as string | null,
    contact_email: "owner@desmit.example", owner_email: "login@desmit.example",
    settings: { email_alerts: true as boolean | undefined, greeting: null, forward_number: "(408) 348-7284", textback_message: null,
      hours: { text: "Mon–Fri 8–5" }, after_hours: null, knowledge: "3D printing and laser cutting." } },
};
let messages: Array<Record<string, unknown>> = [];
let sms: Array<{ To: string; Body: string; From: string | null }> = [];
let emails: Array<{ to: string[]; subject: string; html: string; text: string }> = [];
let calBookings: Array<Record<string, unknown>> = [];
let aiEnabled = true;
let failNextTextbackClaim = false;
let twilioDown = false;
let pushTokens: Array<{ token: string; user_id: string }> = [];
let admins: string[] = [];
let pushes: Array<Record<string, unknown>> = [];
let expoGone = new Set<string>();

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
    if (table === "lpc_push_tokens") {
      if (method === "DELETE") {
        const t = decodeURIComponent(url.searchParams.get("token")!.replace(/^eq\./, ""));
        pushTokens = pushTokens.filter((p) => p.token !== t);
        return ok([]);
      }
      const ids = (url.searchParams.get("user_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",");
      return ok(pushTokens.filter((p) => ids.includes(p.user_id)).map((p) => ({ token: p.token })));
    }
    if (table === "dd_profiles") return ok(admins.map((id) => ({ id })));
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
            (!eq("client_id") || m.client_id === eq("client_id")) &&
            (!eq("meta->>emailed") || String((m.meta as Record<string, unknown>)?.emailed) === eq("meta->>emailed")) &&
            (!eq("from_phone") || m.from_phone === eq("from_phone")) &&
            (!eq("meta->>channel") || (m.meta as Record<string, unknown>)?.channel === eq("meta->>channel")) &&
            (!eq("meta->>via") || (m.meta as Record<string, unknown>)?.via === eq("meta->>via"))
          ).length;
          return ok([], { "content-range": `0-0/${n}` });
        }
        return ok(messages.filter((m) => m.external_id === eq("external_id")));
      }
      if (method === "PATCH") {
        const id = url.searchParams.get("external_id")?.replace(/^eq\./, "");
        const patch = JSON.parse(String(init!.body));
        messages = messages.map((m) => (m.external_id === id ? { ...m, ...patch } : m));
        return ok([]);
      }
      const row = JSON.parse(String(init!.body));
      if (failNextTextbackClaim && String(row.external_id).endsWith(":textback")) {
        failNextTextbackClaim = false;
        return new Response("boom", { status: 503 });
      }
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
  if (url.host === "api.resend.com") {
    assertEquals(new Headers(init!.headers).get("Authorization"), "Bearer re_test");
    emails.push(JSON.parse(String(init!.body)));
    return ok({ id: "em_1" });
  }
  if (url.host === "exp.host") {
    const batch = JSON.parse(String(init!.body)) as Array<Record<string, unknown>>;
    pushes.push(...batch);
    return ok({ data: batch.map((m) => expoGone.has(String(m.to))
      ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: "tk" }) });
  }
  if (url.host === "api.twilio.com") {
    const f = new URLSearchParams(String(init!.body));
    if (twilioDown) return new Response("{}", { status: 400 });
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
const reset = () => {
  twilioDown = false;
  pushTokens = []; pushes = []; admins = []; expoGone = new Set(); line.client.owner_id = "u-1";
  messages = []; sms = []; emails = []; calBookings = []; aiEnabled = true; failNextTextbackClaim = false;
  line.client.settings.email_alerts = true;
  line.enabled = true; line.texting_enabled = true; line.client.status = "active"; delete (line as Record<string, unknown>).ai_enabled;
};

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

Deno.test("DB blip at hang-up: 500 so Vapi retries, and the retry still texts exactly once", async () => {
  reset();
  const report = { type: "end-of-call-report", call: call("f1"), endedReason: "customer-ended-call",
    artifact: { messages: [{ role: "user", message: "need a quote" }] }, analysis: { summary: "Wants a quote" } };
  const a = await (await vapi({ type: "assistant-request", call: call("f1") })).json();
  assertEquals(a.assistant.server.backoffPlan.maxRetries, 3);
  failNextTextbackClaim = true;
  assertEquals((await vapi(report)).status, 500);
  assertEquals(sms.filter((m) => m.To === "+15125551234").length, 0);
  assertEquals((await vapi(report)).status, 200);
  await vapi(report);
  assertEquals(sms.filter((m) => m.To === "+15125551234").length, 1);
});

Deno.test("switched-off line or cancelled client: no texts, and the fallback doesn't promise one", async () => {
  reset();
  line.enabled = false;
  const a = await (await vapi({ type: "assistant-request", call: call("d1") })).json();
  assertMatch(a.assistant.firstMessage, /try again/);
  await vapi({ type: "end-of-call-report", call: call("d1"), endedReason: "customer-ended-call",
    artifact: { messages: [] }, analysis: {} });
  line.enabled = true; line.client.status = "cancelled";
  await vapi({ type: "end-of-call-report", call: call("d2"), endedReason: "customer-ended-call",
    artifact: { messages: [] }, analysis: {} });
  assertEquals(sms.length, 0);
});

Deno.test("caller ID = owner's cell (forwarding dropped CLI): owner is never texted a text-back", async () => {
  reset();
  await vapi({ type: "end-of-call-report", call: call("o1", "+14083487284"), endedReason: "customer-ended-call",
    artifact: { messages: [] }, analysis: {} });
  assertEquals(sms.length, 0);
});

Deno.test("blocked caller ID: booking asks for a number instead of looping on Cal.com", async () => {
  reset();
  const r = await (await vapi({ type: "tool-calls", call: { id: "n1", phoneNumberId: "pn_1", customer: {} },
    toolCallList: [{ id: "t1", type: "function", function: { name: "book_appointment",
      arguments: JSON.stringify({ start: SLOT1, name: "Q" }) } }] })).json();
  assertMatch(r.results[0].result, /callback number first/);
  assertEquals(calBookings.length, 0);
});

globalThis.addEventListener("unload", () => { globalThis.fetch = realFetch; });

Deno.test("texts sent by the Text-Back app don't use up the Twilio text-back allowance", async () => {
  reset();
  messages.push({ external_id: "dev:d1:7:textback", kind: "textback", from_phone: "+15125551234",
    created_at: new Date().toISOString(), meta: { via: "gw-device" } });
  await vapi({ type: "end-of-call-report", call: call("call_dev"), artifact: { messages: [] } });
  assertEquals(sms.filter((m) => m.To === "+15125551234").length, 1);
});

Deno.test("owner switched the AI off: caller gets the short message promising a text, and the text-back", async () => {
  reset();
  (line as Record<string, unknown>).ai_enabled = false;
  const r = await (await vapi({ type: "assistant-request", call: call("c_aioff") })).json();
  assertEquals(r.assistant.name, "Fallback desk");
  assertMatch(r.assistant.firstMessage, /we'll text you right back/);
  await vapi({ type: "end-of-call-report", call: call("c_aioff"), endedReason: "customer-ended-call",
    artifact: { messages: [{ role: "assistant", message: "Thanks for calling" }] }, analysis: {} });
  assertEquals(sms.filter((m) => m.To === "+15125551234").length, 1);
});

// ---------- lead alert email ----------
const report = (id: string, opts: { customer?: string; talked?: boolean; summary?: string } = {}) =>
  vapi({ type: "end-of-call-report", call: call(id, opts.customer), endedReason: "customer-ended-call",
    artifact: { messages: opts.talked === false ? [] : [{ role: "user", message: "hi" }] },
    analysis: opts.summary ? { summary: opts.summary } : {} });

Deno.test("a call emails the business's contact email once: who, tappable number, what they need", async () => {
  reset();
  await report("e1", { summary: "Jane wants a quote for a website." });
  assertEquals(emails.length, 1);
  const e = emails[0];
  assertEquals(e.to, ["owner@desmit.example"]);
  assertMatch(e.subject, /^New call for DeSmit Designs: \(512\) 555-1234 — Jane wants a quote/);
  assertMatch(e.html, /href="tel:\+15125551234"/);
  assertMatch(e.html, /groundwork\/portal\//);
  assertMatch(e.text, /What they need: Jane wants a quote for a website\./);
  assert(!/transcript/i.test(e.html), "the transcript stays in the portal");
  const row = messages.find((m) => m.external_id === "e1")!;
  assertEquals((row.meta as Record<string, unknown>).emailed, true);
  // Vapi retries the report: still one email
  await report("e1", { summary: "Jane wants a quote for a website." });
  assertEquals(emails.length, 1);
});

Deno.test("email goes out even when the text alert can't (no texting yet), and names the caller", async () => {
  reset();
  await vapi({ type: "tool-calls", call: call("e2"),
    toolCallList: [{ id: "t1", type: "function", function: { name: "take_message",
      arguments: JSON.stringify({ name: "<b>Bo</b>", message: "Call me about 50 keychains", urgent: true }) } }] });
  await report("e2", { summary: "x" });
  assertEquals(emails.length, 1);
  assertMatch(emails[0].subject, /^URGENT: New call for DeSmit Designs: <b>Bo<\/b> · \(512\) 555-1234/);
  assert(!emails[0].html.includes("<b>Bo</b>"), "caller-supplied text is escaped in the HTML");
  assertMatch(emails[0].html, /&lt;b&gt;Bo&lt;\/b&gt;/);
});

Deno.test("no email when alerts are off, the line is off, or there's no valid address", async () => {
  reset();
  line.client.settings.email_alerts = false;
  await report("e3", { summary: "hello" });
  assertEquals(emails.length, 0);
  reset();
  line.enabled = false;
  await report("e4", { summary: "hello" });
  assertEquals(emails.length, 0);
  reset();
  const saved = line.client.contact_email;
  line.client.contact_email = "not an email";
  line.client.owner_email = "";
  await report("e5", { summary: "hello" });
  assertEquals(emails.length, 0);
  line.client.contact_email = saved; line.client.owner_email = "login@desmit.example";
  // pre-migration settings (no email_alerts column) = on
  reset();
  delete line.client.settings.email_alerts;
  await report("e6", { summary: "hello" });
  assertEquals(emails.length, 1);
});

Deno.test("daily email cap per line; a silent hang-up with no caller ID isn't emailed", async () => {
  reset();
  for (const id of ["f1", "f2", "f3", "f4"]) {
    await report(id, { customer: "+1512555" + id.slice(1).padStart(4, "0"), summary: "need help" });
  }
  assertEquals(emails.length, 3); // RL_EMAIL_DAY=3 in this file; the 4th is still in the inbox
  assert(messages.some((m) => m.external_id === "f4"));
  reset();
  await vapi({ type: "end-of-call-report", call: { id: "f5", phoneNumberId: "pn_1", customer: {} },
    endedReason: "customer-ended-call", artifact: { messages: [] }, analysis: {} });
  assertEquals(emails.length, 0);
});

// ---------- texting switch (012) ----------
Deno.test("texting not approved yet: no texts sent or promised, owner still emailed", async () => {
  reset();
  line.texting_enabled = false;
  const sys = (await (await vapi({ type: "assistant-request", call: call("x1") })).json())
    .assistant.model.messages[0].content as string;
  assertMatch(sys, /owner will call them back — don't promise a text/);
  assert(!/they'll get a text/.test(sys));
  const saved = (await (await vapi({ type: "tool-calls", call: call("x1"),
    toolCallList: [{ id: "t1", type: "function", function: { name: "take_message",
      arguments: JSON.stringify({ message: "Quote please" }) } }] })).json()).results[0].result as string;
  assertMatch(saved, /will call them back\.$/);
  await report("x1", { summary: "Quote please" });
  assertEquals(sms.length, 0);
  assert(!messages.some((m) => m.kind === "textback"), "no text-back is even claimed");
  assertEquals(emails.length, 1);
});

Deno.test("texting off + AI off: the fallback promises a call back, not a text", async () => {
  reset();
  line.texting_enabled = false;
  aiEnabled = false;
  const a = (await (await vapi({ type: "assistant-request", call: call("x2") })).json()).assistant;
  assertMatch(a.firstMessage, /we'll call you back soon/);
});

Deno.test("texting off: repeat silent hang-ups from one number are emailed once a day", async () => {
  reset();
  line.texting_enabled = false;
  const silent = (id: string) => vapi({ type: "end-of-call-report", call: call(id, "+15125559999"),
    endedReason: "customer-ended-call", artifact: { messages: [] }, analysis: {} });
  await silent("x3"); await silent("x4");
  assertEquals(emails.length, 1);
});

Deno.test("the text-back row records whether Twilio actually sent it (monthly reports count sent only)", async () => {
  reset();
  await report("s1", { talked: false });
  const ok = messages.find((m) => m.external_id === "s1:textback")!;
  assertEquals((ok.meta as Record<string, unknown>).sent, true);
  reset();
  twilioDown = true;
  await report("s2", { customer: "+15125550177", talked: false });
  const failed = messages.find((m) => m.external_id === "s2:textback")!;
  assertEquals((failed.meta as Record<string, unknown>).sent, false);
});

const TOK = "ExponentPushToken[abcdefghij123]", TOK2 = "ExponentPushToken[zyxwvutsrq987]";

Deno.test("a call pushes once to the owner's phones: who and what they need, opening the inbox", async () => {
  reset();
  pushTokens = [{ token: TOK, user_id: "u-1" }, { token: "ExponentPushToken[someoneelse00]", user_id: "u-2" }];
  await report("p1", { summary: "Jane wants a quote for a website." });
  assertEquals(pushes.length, 1);
  const p = pushes[0];
  assertEquals(p.to, TOK);
  assertEquals(p.title, "New call: (512) 555-1234");
  assertMatch(String(p.body), /Jane wants a quote/);
  assertEquals(p.channelId, "calls");
  assertEquals((p.data as Record<string, unknown>).url, "/inbox");
  assertEquals((messages.find((m) => m.external_id === "p1")!.meta as Record<string, unknown>).pushed, true);
  await report("p1", { summary: "Jane wants a quote for a website." }); // Vapi retry
  assertEquals(pushes.length, 1);
});

Deno.test("push: an uninstalled app's token is deleted; no tokens or no owner means no push", async () => {
  reset();
  pushTokens = [{ token: TOK, user_id: "u-1" }, { token: TOK2, user_id: "u-1" }];
  expoGone = new Set([TOK2]);
  await report("p2");
  assertEquals(pushes.length, 2);
  assertEquals(pushTokens.map((t) => t.token), [TOK]);
  reset();
  await report("p3");
  assertEquals(pushes.length, 0);
  reset();
  pushTokens = [{ token: TOK, user_id: "u-1" }];
  line.client.owner_id = null;
  await report("p4");
  assertEquals(pushes.length, 0);
});

const UA = "aaaaaaaa-0000-4000-8000-000000000001", TOK_A = "ExponentPushToken[studioadmin0001]";

Deno.test("the studio's phones get every client's calls, titled with the business, once per call", async () => {
  reset();
  admins = [UA];
  pushTokens = [{ token: TOK, user_id: "u-1" }, { token: TOK_A, user_id: UA }];
  await report("s-a1", { summary: "Jane wants a quote for a website." });
  assertEquals(pushes.length, 2);
  const studio = pushes.find((p) => p.to === TOK_A)!;
  assertMatch(String(studio.title), new RegExp("^" + line.client.business_name + ": "));
  assertEquals((studio.data as Record<string, unknown>).url, "/studio/client");
  assertEquals((studio.data as Record<string, unknown>).client_id, line.client_id);
  assertEquals(pushes.find((p) => p.to === TOK)!.data, { url: "/inbox", client_id: line.client_id });
  assertEquals((messages.find((m) => m.external_id === "s-a1")!.meta as Record<string, unknown>).pushed_studio, true);
  await report("s-a1", { summary: "Jane wants a quote for a website." }); // Vapi retry
  assertEquals(pushes.length, 2);
});

Deno.test("studio alerts: sent with no owner login; an admin who owns the business gets one alert", async () => {
  reset();
  admins = [UA];
  pushTokens = [{ token: TOK_A, user_id: UA }];
  line.client.owner_id = null;
  await report("s-a2");
  assertEquals(pushes.map((p) => p.to), [TOK_A]);
  reset();
  admins = [UA];
  pushTokens = [{ token: TOK_A, user_id: UA }];
  line.client.owner_id = UA;
  await report("s-a3");
  assertEquals(pushes.length, 1);
  assertEquals((pushes[0].data as Record<string, unknown>).url, "/inbox");
});
