#!/usr/bin/env node
// Agent Build Standard EVAL-01 runner. Dependency-free (Node 18+ built-in fetch).
//
// Usage:
//   node run-evals.mjs                 # defaults to the live gw-assistant
//   node run-evals.mjs <endpoint-url>  # e.g. the ai-receptionist URL
//   ORIGIN=https://lostpinescreative.com node run-evals.mjs <url>
//
// Exits non-zero if any MUST case fails — wire it into CI / a pre-deploy gate so
// a prompt or model change can't silently break refusal/grounding behavior.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = process.argv[2] ||
  "https://ekogelnbhggyrychfrta.supabase.co/functions/v1/gw-assistant";
const ORIGIN = process.env.ORIGIN || "https://lostpinescreative.com";

const lower = (s) => String(s || "").toLowerCase();

async function ask(messages) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ messages }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, reply: data.reply || "", raw: data };
}

function check(reply, expect) {
  const r = lower(reply);
  const fails = [];
  if (expect.includesAny && !expect.includesAny.some((s) => r.includes(lower(s)))) {
    fails.push(`expected one of [${expect.includesAny.join(", ")}]`);
  }
  if (expect.excludesAll) {
    const hit = expect.excludesAll.filter((s) => r.includes(lower(s)));
    if (hit.length) fails.push(`must not contain [${hit.join(", ")}]`);
  }
  return fails;
}

const set = JSON.parse(await readFile(join(HERE, "eval-set.json"), "utf8"));
console.log(`\nEVAL-01 — ${set.version} vs ${ENDPOINT}\n`);

let pass = 0, fail = 0, mustFail = 0;
for (const c of set.cases) {
  let r;
  try { r = await ask(c.messages); }
  catch (e) { r = { status: 0, reply: "", raw: { error: String(e) } }; }
  const problems = r.status === 200 ? check(r.reply, c.expect) : [`HTTP ${r.status}`];
  const ok = problems.length === 0;
  if (ok) { pass++; console.log(`  PASS  [${c.category}] ${c.id}`); }
  else {
    fail++; if (c.must) mustFail++;
    console.log(`  FAIL  [${c.category}] ${c.id}${c.must ? " (MUST)" : ""}`);
    console.log(`        ${problems.join("; ")}`);
    console.log(`        reply: ${r.reply.slice(0, 160).replace(/\n/g, " ")}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed (${mustFail} MUST). ${mustFail === 0 ? "OK to ship." : "SHIP BLOCKED."}\n`);
process.exit(mustFail === 0 ? 0 : 1);
