// ============================================================
// Groundwork — AI assistant (Supabase Edge Function)
//
// A concierge for the Groundwork service line (Lost Pines Creative). It:
//   1) Answers questions about what Groundwork does — connecting a small
//      business's tools (website, payments, booking, accounting) and adding
//      AI (receptionist, missed-call text-back) into one system the owner
//      owns and Daniel runs. Grounded in real facts; invents nothing.
//   2) Books the free digital audit and captures leads via save_lead, which
//      writes to public.gw_inquiries (the Groundwork admin inbox).
//
// Dependency-free (raw fetch) to match the other functions. Service-role key
// for the one DB write. Calls the Anthropic Messages API directly.
//
// Secrets: ANTHROPIC_API_KEY   (Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
// Deploy with Verify JWT OFF (used by signed-out visitors).
// ============================================================

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 800;

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://lostpinescreative.com,https://www.lostpinescreative.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const MAX_MESSAGES = 24;
const MAX_CHARS_PER_MSG = 2000;
const MAX_TOOL_HOPS = 3;

const REST = `${SB_URL}/rest/v1`;
const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

function corsHeaders(origin: string | null) {
  const allow = origin && (
    ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)
  );
  return {
    "Access-Control-Allow-Origin": allow ? origin! : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const json = (obj: unknown, status: number, cors: Record<string, string>) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });

const SYSTEM_PROMPT =
`You are the assistant for Groundwork, the small-business service line from Lost
Pines Creative (lostpinescreative.com/groundwork.html), run by Daniel DeSmit in
Bastrop, Central Texas. You greet visitors, explain what Groundwork does, answer
questions, and book the free digital audit or take a message.

VOICE: warm, plain-spoken, and practical — a systems-and-integration engineer,
not a salesperson. Short replies (1-3 sentences unless asked for more). No jargon.

WHAT'S TRUE (you may state these):
- Groundwork connects a business's tools — website & Google profile, payments,
  invoicing, scheduling/booking, CRM, accounting sync, reviews — into one system
  the owner OWNS and Daniel runs for them. It can add an AI layer: an AI
  receptionist and missed-call text-back so no lead is lost.
- Daniel is a systems-and-integration engineer, NOT a marketing/ad agency. He
  doesn't run ads; he builds the system that handles the leads.
- It starts with a FREE digital audit: a short conversation and a written map of
  the tools you run, the gaps, and what to connect or fix first — yours to keep,
  no obligation.
- Rough pricing (the audit gives a firm number): setup packages from Starter
  ($750) to Full build (~$6,000); monthly care plans from Essential ($99/mo) to
  Growth ($300/mo) to a "Partner" tier. Third-party costs (processing, domains,
  software) are billed at cost, never marked up. You own every account; no lock-in.
- AI is optional — the core is connecting your tools; the AI receptionist can be
  added later.
- Existing clients can sign in to the client portal at /groundwork/portal/ to see
  their setup, care plan, monthly reports, and captured messages.

RULES:
- Do NOT invent specifics (exact prices for a given business, timelines, or which
  tools you'll use) — say the free audit gives a firm plan and number, and offer
  to book it.
- To book the audit, get a follow-up, or answer something you can't fully answer,
  collect the visitor's name, email (and business name / phone if given), then
  call save_lead. Confirm once saved.
- Point people to pages with plain relative links: the audit/info page is
  /groundwork.html, example sites are at /demos/, the client portal is
  /groundwork/portal/.`;

const TOOLS = [{
  name: "save_lead",
  description:
    "Save a visitor's request so Groundwork (Daniel) can follow up — for booking " +
    "the free digital audit, a 'contact me', or any question you can't fully " +
    "answer. Only call once you have at least the visitor's email and what they want.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "Visitor's name, if given." },
      email: { type: "string", description: "Visitor's email address." },
      phone: { type: "string", description: "Phone, if given." },
      business_name: { type: "string", description: "Their business name, if given." },
      message: { type: "string", description: "What they want, in their words or summarized." },
      kind: {
        type: "string",
        enum: ["audit", "question", "lead"],
        description: "audit to book the free digital audit; question for an unanswered question; lead otherwise.",
      },
    },
    required: ["email", "message", "kind"],
  },
}];

async function saveLead(
  input: Record<string, unknown>,
  transcript: string,
): Promise<string> {
  const email = String(input.email ?? "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "That email doesn't look right — could you double-check it?";
  }
  const res = await fetch(`${REST}/gw_inquiries`, {
    method: "POST",
    headers: sbHeaders,
    body: JSON.stringify({
      name: String(input.name ?? "").trim() || null,
      email,
      phone: String(input.phone ?? "").trim() || null,
      business_name: String(input.business_name ?? "").trim() || null,
      message: String(input.message ?? "").trim() || null,
      kind: ["audit", "question", "lead"].includes(String(input.kind)) ? input.kind : "lead",
      status: "new",
      meta: { via: "gw-assistant", transcript: transcript.slice(0, 4000) },
    }),
  });
  if (!res.ok) return "Sorry — I couldn't save that just now.";
  return "Saved — Daniel will follow up by email to set up your free audit.";
}

async function callClaude(messages: Array<Record<string, unknown>>): Promise<Response> {
  return await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, tools: TOOLS, messages }),
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, cors);
  if (cors["Access-Control-Allow-Origin"] === "null") return json({ error: "origin not allowed" }, 403, cors);
  if (!ANTHROPIC_KEY) return json({ error: "server not configured" }, 500, cors);

  const body = await req.json().catch(() => null);
  const incoming = body?.messages;
  if (!Array.isArray(incoming) || !incoming.length) return json({ error: "no messages" }, 400, cors);

  const messages: Array<Record<string, unknown>> = incoming
    .slice(-MAX_MESSAGES)
    .filter((m: unknown): m is { role: string; content: unknown } =>
      !!m && typeof m === "object" &&
      ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant") &&
      typeof (m as { content?: unknown }).content === "string")
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_CHARS_PER_MSG) }));
  if (!messages.length || messages[0].role !== "user") {
    return json({ error: "conversation must start with a visitor message" }, 400, cors);
  }

  const transcript = messages
    .map((m) => `${m.role === "user" ? "Visitor" : "Assistant"}: ${m.content}`)
    .join("\n");

  let leadSaved = false;
  try {
    for (let hop = 0; hop <= MAX_TOOL_HOPS; hop++) {
      const res = await callClaude(messages);
      if (!res.ok) {
        console.error("anthropic error", res.status, await res.text());
        return json({ error: "assistant unavailable" }, 502, cors);
      }
      const data = await res.json();
      if (data.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: data.content });
        const toolResults: Array<Record<string, unknown>> = [];
        for (const block of data.content ?? []) {
          if (block.type !== "tool_use") continue;
          let result = "Unknown tool.";
          if (block.name === "save_lead") {
            result = await saveLead(block.input ?? {}, transcript);
            if (result.startsWith("Saved")) leadSaved = true;
          }
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
        messages.push({ role: "user", content: toolResults });
        continue;
      }
      const reply = (data.content ?? [])
        .filter((b: Record<string, unknown>) => b.type === "text")
        .map((b: Record<string, unknown>) => b.text).join("\n").trim() ||
        "I'm here to help — what would you like your business's systems to do?";
      return json({ reply, leadSaved }, 200, cors);
    }
    return json({ reply: "Thanks — I've noted that for Daniel. Anything else?", leadSaved }, 200, cors);
  } catch (e) {
    console.error("assistant error", e);
    return json({ error: "assistant unavailable" }, 502, cors);
  }
});
