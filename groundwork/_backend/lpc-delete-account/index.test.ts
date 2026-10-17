// Behaviour tests for lpc-delete-account — fakes Supabase Auth, PostgREST, Storage and Resend.
// The SQL half (lpc_delete_account_data) is tested against Postgres; this tests the orchestration.
// Run: deno test -A groundwork/_backend/lpc-delete-account/index.test.ts
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "https://proj.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "srk");
Deno.env.set("RESEND_API_KEY", "re_test");

const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000003";
const sessions: Record<string, { id: string; email: string }> = {
  "jwt-user": { id: USER, email: "owner@biz.com" },
  "jwt-admin": { id: ADMIN, email: "admin@lpc.com" },
};
let calls: string[] = [];
let purgeQueue: Array<{ bucket: string; path: string; deleted_user_id: string }> = [];
let deletedUsers: string[] = [];
let emails: Array<Record<string, unknown>> = [];
let fail: Record<string, boolean> = {};

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
function fake(input: string | URL | Request, init?: RequestInit): Response {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const m = init?.method ?? "GET";
  calls.push(`${m} ${url.pathname}`);
  if (url.host === "api.resend.com") { emails.push(JSON.parse(String(init!.body))); return ok({}); }
  if (url.pathname === "/auth/v1/user") {
    const u = sessions[(new Headers(init?.headers).get("Authorization") ?? "").replace(/^Bearer /, "")];
    return u ? ok(u) : new Response("{}", { status: 401 });
  }
  if (url.pathname === "/rest/v1/rpc/lpc_delete_account_data") {
    if (fail.rpc) return new Response("boom", { status: 500 });
    if (fail.rpcGrant) return new Response('{"code":"42883","message":"permission denied"}', { status: 403 });
    const { p_user } = JSON.parse(String(init!.body));
    if (p_user === ADMIN) return new Response('{"code":"42501"}', { status: 403 });
    purgeQueue.push({ bucket: "dd-attachments", path: `p1/1-photo.jpg`, deleted_user_id: p_user });
    return ok({ detached_clients: ["Bastrop <Plumbing>"], deleted_projects: 1,
      detached_intakes: [{ business_name: "Bastrop Plumbing", pay_status: "paid", stripe_subscription_id: "sub_123" }] });
  }
  if (url.pathname === "/rest/v1/lpc_storage_purge") {
    if (m === "DELETE") {
      const q = url.searchParams;
      purgeQueue = purgeQueue.filter((r) =>
        !(`eq.${r.bucket}` === q.get("bucket") && `eq.${r.deleted_user_id}` === q.get("deleted_user_id")));
      return ok([]);
    }
    return ok(purgeQueue.filter((r) => `eq.${r.deleted_user_id}` === url.searchParams.get("deleted_user_id")));
  }
  if (url.pathname === "/storage/v1/object/dd-attachments" && m === "DELETE") {
    if (fail.storage) return new Response("down", { status: 500 });
    assertEquals(JSON.parse(String(init!.body)).prefixes, ["p1/1-photo.jpg"]);
    return ok([]);
  }
  if (url.pathname.startsWith("/auth/v1/admin/users/") && m === "DELETE") {
    if (fail.authDelete) return new Response("down", { status: 500 });
    deletedUsers.push(url.pathname.split("/").pop()!);
    return ok({});
  }
  throw new Error(`unexpected fetch ${m} ${url}`);
}
globalThis.fetch = ((i: string | URL | Request, init?: RequestInit) =>
  Promise.resolve().then(() => fake(i, init))) as typeof fetch;

let handler!: (r: Request) => Promise<Response>;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: typeof handler) => { handler = h; };
await import("./index.ts");

const FN = "https://proj.supabase.co/functions/v1/lpc-delete-account";
const del = (jwt: string | null, body: unknown = { confirm: "DELETE" }) =>
  handler(new Request(FN, {
    method: "POST",
    headers: { "content-type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(body),
  }));
const reset = () => { calls = []; purgeQueue = []; deletedUsers = []; emails = []; fail = {}; };

Deno.test("deletes in order: data (detach/delete) -> files -> auth user -> studio email", async () => {
  reset();
  const r = await del("jwt-user");
  assertEquals(r.status, 200);
  const order = calls.filter((c) => !c.includes("/auth/v1/user") && !c.includes("lpc_storage_purge"));
  assertEquals(order, [
    "POST /rest/v1/rpc/lpc_delete_account_data",
    "DELETE /storage/v1/object/dd-attachments",
    `DELETE /auth/v1/admin/users/${USER}`,
    "POST /emails",
  ]);
  assertEquals(deletedUsers, [USER]);
  assertEquals(purgeQueue.length, 0);
  assertMatch(String(emails[0].html), /Bastrop &lt;Plumbing&gt;/);
});

Deno.test("must type DELETE; must be signed in; admin accounts refused", async () => {
  reset();
  assertEquals((await del("jwt-user", { confirm: "delete" })).status, 400);
  assertEquals((await del("jwt-user", {})).status, 400);
  assertEquals((await del(null)).status, 401);
  assertEquals((await del("jwt-nobody")).status, 401);
  const a = await del("jwt-admin");
  assertEquals(a.status, 403);
  assertEquals((await a.json()).code, "admin_account");
  assertEquals(deletedUsers.length, 0);
});

Deno.test("data step fails -> 503 and the login is NOT deleted (business records can't be cascaded)", async () => {
  reset();
  fail.rpc = true;
  assertEquals((await del("jwt-user")).status, 503);
  assertEquals(deletedUsers.length, 0);
});

Deno.test("storage down -> files stay queued, account still deleted", async () => {
  reset();
  fail.storage = true;
  assertEquals((await del("jwt-user")).status, 200);
  assertEquals(purgeQueue.length, 1);
  assertEquals(deletedUsers, [USER]);
});

Deno.test("auth delete fails -> 503; running again finishes", async () => {
  reset();
  fail.authDelete = true;
  const r = await del("jwt-user");
  assertEquals(r.status, 503);
  assertEquals((await r.json()).code, "retry");
  fail.authDelete = false;
  assertEquals((await del("jwt-user")).status, 200);
  assert(deletedUsers.includes(USER));
});

Deno.test("studio email lists onboarding records kept and any live Stripe subscription", async () => {
  reset();
  await del("jwt-user");
  assertMatch(String(emails[0].html), /Onboarding records kept/);
  assertMatch(String(emails[0].html), /sub_123/);
});

Deno.test("a 403 that isn't the admin refusal (e.g. missing grant) is a 503, never 'you are an admin'", async () => {
  reset();
  fail.rpcGrant = true;
  const r = await del("jwt-user");
  assertEquals(r.status, 503);
  assertEquals(deletedUsers.length, 0);
});
