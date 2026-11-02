// deno test groundwork/_backend/gw-ring/gw-ring.test.ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { accept, after, e164, inbound, signatureOk, whisper } from "./twiml.ts";

const FN = "https://x.supabase.co/functions/v1/gw-ring";
const PUB = "+17375550100", AI = "+18665550100", CELL = "+15125550199", CUST = "+15125550123";
const route = { publicNumber: PUB, aiNumber: AI, cell: CELL };

Deno.test("rings the cell showing the business number, with the customer in the whisper", () => {
  const x = inbound(route, FN, CUST, null);
  assertStringIncludes(x, `callerId="${PUB}"`);
  assertStringIncludes(x, `>${CELL}</Number>`);
  assertStringIncludes(x, `step=whisper&amp;c=%2B15125550123`);
  assertStringIncludes(x, `action="${FN}?step=after"`);
});

Deno.test("loop guards go straight to the AI and never ring the cell", () => {
  for (const x of [
    inbound(route, FN, PUB, null), // forwarded back, showing the business number
    inbound(route, FN, CELL, null), // owner calling their own line
    inbound(route, FN, CUST, CELL), // carrier reports the cell forwarded it
    inbound({ ...route, cell: null }, FN, CUST, null), // no cell on file
  ]) {
    assertStringIncludes(x, `>${AI}</Number>`);
    assert(!x.includes(`>${CELL}</Number>`));
  }
});

Deno.test("hidden caller still rings, and the AI leg uses the business number", () => {
  const x = inbound(route, FN, "anonymous", null);
  assertStringIncludes(x, `>${CELL}</Number>`);
  assert(!x.includes("&amp;c="));
  assertStringIncludes(whisper(FN, null), "an unknown number");
  assertStringIncludes(after(route, "false", "anonymous"), `callerId="${PUB}"`);
});

Deno.test("whisper speaks digits and hangs up with no key press", () => {
  const x = whisper(FN, CUST);
  assertStringIncludes(x, "5 1 2 5 5 5 0 1 2 3");
  assert(x.endsWith("</Gather><Hangup/></Response>"));
});

Deno.test("only 1 accepts", () => {
  assert(!accept("1").includes("Hangup"));
  for (const d of ["2", "", null]) assertStringIncludes(accept(d), "<Hangup/>");
});

Deno.test("after: bridged ends, anything else reaches the AI with the customer's number", () => {
  assertStringIncludes(after(route, "true", CUST), "<Hangup/>");
  for (const b of ["false", null]) {
    const x = after(route, b, CUST);
    assertStringIncludes(x, `>${AI}</Number>`);
    assertStringIncludes(x, `callerId="${CUST}"`);
  }
});

Deno.test("e164 rejects what Twilio sends for hidden callers and markup", () => {
  for (const bad of ["anonymous", "unknown", "", null, `+1"><Hangup/>`]) assertEquals(e164(bad), null);
  assertEquals(e164(CUST), CUST);
});

Deno.test("signature matches an independent HMAC, fails closed otherwise", async () => {
  const url = "https://x.supabase.co/functions/v1/gw-ring?step=whisper&c=%2B15125550123";
  const p = new URLSearchParams({ To: "+15125550199", CallSid: "CA1", Digits: "1" });
  const good = "Hi3vAmYaj6QN7vPfAK+a5wINflc="; // node crypto, sorted params appended to the URL
  assert(await signatureOk("test-token", url, p, good));
  assert(!await signatureOk("wrong", url, p, good));
  assert(!await signatureOk("test-token", url + "x", p, good));
  assert(!await signatureOk("test-token", url, new URLSearchParams({ To: "+1", CallSid: "CA1", Digits: "1" }), good));
  assert(!await signatureOk("", url, p, good));
  assert(!await signatureOk("test-token", url, p, ""));
});
