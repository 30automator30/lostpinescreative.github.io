// ============================================================
// DeSmit Designs — AI assistant (Supabase Edge Function)
//
// A studio concierge for desmitdesigns. It:
//   1) Answers questions about the shop's real services, equipment, materials,
//      and how a project works — grounded in facts, inventing nothing.
//   2) Helps a visitor scope a project (what's possible, rough considerations).
//   3) Captures a service request / lead via save_request, which writes to
//      public.dd_inquiries — the table the Admin console reads.
//
// Dependency-free (raw fetch) to match the Blue Plumeria functions and deploy
// cleanly from the dashboard editor. Uses the service-role key for the one DB
// write (bypasses RLS). Calls the Anthropic Messages API directly.
//
// Secrets (set on THIS project): ANTHROPIC_API_KEY
// Injected automatically:        SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy with Verify JWT OFF (the widget may be used by signed-out visitors).
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

// ── Brand + capability grounding. States only what's TRUE and routes
//    unknowns (exact price/turnaround) to a real quote instead of inventing. ──
const SYSTEM_PROMPT =
`You are the assistant for DeSmit Designs (desmitdesigns, at
lostpinescreative.com/desmitdesigns), a design & fabrication studio in Bastrop,
Texas run by Daniel DeSmit, an engineer with 15+ years of professional design
experience (medical devices, consumer products, industrial design). You greet
visitors, answer questions about the shop, help them think through a project,
and take down a request when the studio should follow up.

VOICE: friendly, precise, and practical — a maker-engineer who knows the tools.
Keep replies short (1–3 sentences unless asked for detail). Never pushy.

WHAT'S TRUE (you may state these):
- Services: multi-color/multi-material FDM 3D printing (up to 16 colors),
  high-resolution 12K resin (MSLA) printing, CAD & engineering design,
  laser cutting & engraving, product development (concept → manufactured part),
  graphic design & branding, and custom one-off commissions.
- Equipment: Bambu Lab P1S + AMS (FDM, up to 16 colors), Elegoo Saturn 4 Ultra
  (12K resin), xTool laser station. Software: SolidWorks, Blender, Bambu Studio,
  LightBurn, Adobe Suite.
- Materials: PLA, PETG, TPU, ASA, 12K resin, wood, acrylic, leather, MDF.
- Max FDM print volume ~256 x 256 x 256 mm.
- Customers can track a project live in the client portal at
  /desmitdesigns/portal/ — where they see status, progress, and their quote.
- Contact: desmitdesignz@gmail.com, (408) 348-7284. Based in Bastrop, Texas.

RULES:
- Do NOT invent specifics you weren't told — exact prices, turnaround times, or
  whether a specific material/finish is in stock. For anything needing a real
  number, say the studio will give a firm quote and offer to take the request.
- To start a project, get a quote, or ask for a human, collect the visitor's
  name, email, and a short description of what they want, then call save_request.
  Confirm once it's saved and mention they can track it in the client portal.
- Point people to pages with plain relative links: the portal is
  /desmitdesigns/portal/, the main site is /desmitdesigns/.`;

const TOOLS = [{
  name: "save_request",
  description:
    "Save a visitor's project request or question so the DeSmit Designs studio " +
    "can follow up. Use for quote requests, new commissions, 'please contact me', " +
    "or any question you cannot fully answer. Only call once you have at least " +
    "the visitor's email and a description of what they want.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "Visitor's name, if given." },
      email: { type: "string", description: "Visitor's email address." },
      message: {
        type: "string",
        description: "What the visitor wants, in their words or summarized.",
      },
      service_type: {
        type: "string",
        description:
          "Best-fit service, e.g. 3d-printing, resin, cad-design, laser, " +
          "product-dev, branding, custom.",
      },
      kind: {
        type: "string",
        enum: ["question", "quote-request", "lead"],
        description:
          "quote-request for a project/commission; question for an unanswered " +
          "question; lead for a general 'contact me'.",
      },
    },
    required: ["email", "message", "kind"],
  },
}];

async function saveRequest(
  input: Record<string, unknown>,
  transcript: string,
): Promise<string> {
  const email = String(input.email ?? "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "That email doesn't look valid — could you double-check it?";
  }
  const res = await fetch(`${REST}/dd_inquiries`, {
    method: "POST",
    headers: sbHeaders,
    body: JSON.stringify({
      name: String(input.name ?? "").trim() || null,
      email,
      message: String(input.message ?? "").trim() || null,
      service_type: String(input.service_type ?? "").trim() || null,
      kind: ["question", "quote-request", "lead"].includes(String(input.kind))
        ? input.kind
        : "lead",
      status: "new",
      meta: { via: "dd-assistant", transcript: transcript.slice(0, 4000) },
    }),
  });
  if (!res.ok) return "Sorry — I couldn't save that just now.";
  return "Saved — the studio will follow up by email. You can also track a " +
    "project any time in the client portal at /desmitdesigns/portal/.";
}

async function callClaude(
  messages: Array<Record<string, unknown>>,
): Promise<Response> {
  return await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }),
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, cors);
  if (cors["Access-Control-Allow-Origin"] === "null") {
    return json({ error: "origin not allowed" }, 403, cors);
  }
  if (!ANTHROPIC_KEY) return json({ error: "server not configured" }, 500, cors);

  const body = await req.json().catch(() => null);
  const incoming = body?.messages;
  if (!Array.isArray(incoming) || !incoming.length) {
    return json({ error: "no messages" }, 400, cors);
  }

  const messages: Array<Record<string, unknown>> = incoming
    .slice(-MAX_MESSAGES)
    .filter((m: unknown): m is { role: string; content: unknown } =>
      !!m && typeof m === "object" &&
      ((m as { role?: unknown }).role === "user" ||
        (m as { role?: unknown }).role === "assistant") &&
      typeof (m as { content?: unknown }).content === "string")
    .map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, MAX_CHARS_PER_MSG),
    }));
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
        const detail = await res.text();
        console.error("anthropic error", res.status, detail);
        return json({ error: "assistant unavailable" }, 502, cors);
      }
      const data = await res.json();

      if (data.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: data.content });
        const toolResults: Array<Record<string, unknown>> = [];
        for (const block of data.content ?? []) {
          if (block.type !== "tool_use") continue;
          let result = "Unknown tool.";
          if (block.name === "save_request") {
            result = await saveRequest(block.input ?? {}, transcript);
            if (result.startsWith("Saved")) leadSaved = true;
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      const reply = (data.content ?? [])
        .filter((b: Record<string, unknown>) => b.type === "text")
        .map((b: Record<string, unknown>) => b.text)
        .join("\n")
        .trim() ||
        "I'm here to help — tell me a bit about what you'd like to make.";
      return json({ reply, leadSaved }, 200, cors);
    }
    return json({
      reply: "Thanks — I've noted that for the studio. Anything else I can help with?",
      leadSaved,
    }, 200, cors);
  } catch (e) {
    console.error("assistant error", e);
    return json({ error: "assistant unavailable" }, 502, cors);
  }
});
