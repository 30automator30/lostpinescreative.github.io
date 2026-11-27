// reel-agent: the nightly reel run's only door into the database. Holds the service role inside; callers present
// x-reel-key (the REEL_AGENT_KEY secret). Deploy with Verify JWT OFF. Owners never call this; they use reel_decide.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const KEY = Deno.env.get("REEL_AGENT_KEY") ?? "";
const BUCKET = "reels";
// Columns the agent may write. status, owner_note and posted belong to the owner except where an action sets them.
const AGENT_COLS = ["id", "series", "number", "title", "hook", "stage", "pr_url", "storyboard_path", "preview_path", "caption", "reviews", "agent_note"];
const ID = /^[a-z0-9][a-z0-9-]{1,80}$/;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Constant-time compare so the key can't be guessed a byte at a time. */
function sameKey(a: string, b: string): boolean {
  if (!b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// deno-lint-ignore no-explicit-any
function must(r: { data: any; error: any }): any {
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

// deno-lint-ignore no-explicit-any
const HANDLERS: Record<string, (a: any) => Promise<unknown>> = {
  /** Everything, newest first: the run uses it to pick numbers and skip reels already in flight. */
  "items.list": async () => {
    // Paged: PostgREST caps one response (max_rows), and a truncated list would hand out duplicate numbers.
    const all: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const page = must(await sb.from("reel_items").select("*").order("id").range(from, from + 999));
      all.push(...page);
      if (page.length < 1000) return all;
    }
  },
  /** Cards the owner has decided and the run hasn't picked up yet. */
  "items.decided": async () => must(await sb.from("reel_items").select("*").in("status", ["approved", "revise", "regenerate"]).order("updated_at")),
  /** Create or update a card. status is "working" (the run has it) or "review" (hand it to the owner). */
  "items.put": async ({ item, status }) => {
    if (!item || !ID.test(item.id ?? "")) throw new Error("bad id");
    if (!["working", "review"].includes(status)) throw new Error("status must be working or review");
    const row: Record<string, unknown> = Object.fromEntries(Object.entries(item).filter(([k]) => AGENT_COLS.includes(k)));
    row.status = status;
    row.run_now = false; // a run has the card now, so the owner's "Do it now" is done
    row.updated_at = new Date().toISOString();
    if (status === "review") row.owner_note = null; // the owner's last note was acted on
    must(await sb.from("reel_items").upsert(row));
    return {};
  },
  /** One-use signed upload URL for reels/<id>/<file>. */
  "upload.url": async ({ id, file }) => {
    if (!ID.test(id ?? "") || !/^[a-z0-9-]+\.(jpg|mp4)$/.test(file ?? "")) throw new Error("bad path");
    const path = `${id}/${file}`;
    const d = must(await sb.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true }));
    return { path, url: d.signedUrl };
  },
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!sameKey(req.headers.get("x-reel-key") ?? "", KEY)) return json(401, { error: "unauthorized" });
  try {
    const { action, ...args } = await req.json();
    const h = HANDLERS[action];
    if (!h) return json(400, { error: `unknown action ${action}` });
    return json(200, await h(args));
  } catch (e) {
    return json(400, { error: e instanceof Error ? e.message : String(e) });
  }
});
