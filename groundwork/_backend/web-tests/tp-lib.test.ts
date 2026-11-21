// Unit tests for /admin/trading-post/tp-lib.js (Trading Post approval + KPI math).
// Run: deno test -A groundwork/_backend/web-tests/
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
// @ts-ignore plain JS module served by the site
import { bookDecisionUpdate, bySection, canApprove, decisionUpdate, fetchAll, fmt, kdpSlotsUsed, latestPerAgent, parsePageList, scorecard, uploadKit, validateDecision } from "../../../admin/trading-post/tp-lib.js";

const DAY = 86400000;
const now = new Date("2026-11-19T12:00:00Z");
const ago = (d: number) => new Date(now.getTime() - d * DAY).toISOString();
const dayAgo = (d: number) => ago(d).slice(0, 10);

Deno.test("canApprove: only pass or flag can be approved", () => {
  assertEquals(canApprove({ compliance: "block" }), false);
  assertEquals(canApprove({ compliance: "pending" }), false);
  assertEquals(canApprove({ compliance: "pass" }), true);
  assertEquals(canApprove({ compliance: "flag" }), true);
});

Deno.test("validateDecision: tweak needs a note and only applies to designs", () => {
  assertEquals(typeof validateDecision("design", "tweak", "  "), "string");
  assertEquals(validateDecision("design", "tweak", "bigger text"), null);
  assertEquals(validateDecision("design", "approved", ""), null);
  assertEquals(validateDecision("concept", "approved", ""), null);
  assertEquals(validateDecision("concept", "rejected", ""), null);
  assertEquals(validateDecision("concept", "tweak", "x y z"), "Unknown decision.");
  assertEquals(typeof validateDecision("concept", "revise", " "), "string");
  assertEquals(validateDecision("concept", "revise", "make it funnier"), null);
  assertEquals(validateDecision("concept", "regenerate", ""), null);
  assertEquals(validateDecision("design", "regenerate", ""), "Unknown decision.");
  assertEquals(validateDecision("design", "revise", "x y z"), "Unknown decision.");
  assertEquals(validateDecision("design", "ship", ""), "Unknown decision.");
});

Deno.test("decisionUpdate: blank note becomes null and only pending rows match", () => {
  const u = decisionUpdate("rejected", "", "T");
  assertEquals(u.values, { review: "rejected", owner_note: null, reviewed_at: "T" });
  assertEquals(u.match, { review: "pending" });
  assertEquals(decisionUpdate("tweak", "  bigger  ", "T").values.owner_note, "bigger");
});

Deno.test("scorecard: no data gives nulls, never NaN or Infinity", () => {
  const s = scorecard([], [], now);
  for (const [k, v] of Object.entries(s)) assertEquals(v, null, k);
  assertEquals(fmt(null, "usd"), "—");
  assertEquals(fmt(Infinity, "int"), "—");
  assertEquals(fmt(NaN, "pct"), "—");
});

Deno.test("scorecard: worked example from the plan", () => {
  const listings = [
    { id: "a", section: "texas", status: "published", published_at: ago(40) },
    { id: "b", section: "texas", status: "published", published_at: ago(40) },
    { id: "c", section: "cars", status: "published", published_at: ago(10) },
    { id: "d", section: "cars", status: "deleted", published_at: ago(40) },
  ];
  const stats = [
    { listing_id: "a", day: dayAgo(5), views: 150, favorites: 10, orders: 2, profit_cents: 1200 },
    { listing_id: "b", day: dayAgo(5), views: 100, favorites: 5, orders: 0, profit_cents: 0 },
    { listing_id: "c", day: dayAgo(3), views: 50, favorites: 0, orders: 1, profit_cents: 600 },
    { listing_id: "d", day: dayAgo(3), views: 999, favorites: 99, orders: 9, profit_cents: 9999 },
  ];
  const s = scorecard(listings, stats, now);
  assertEquals(s.listings, 3);
  assertEquals(s.favoriteRate, 0.05);
  assertEquals(s.conversion, 0.01);
  assertEquals(s.profitPerSale, 6);
  assertEquals(s.profitPerListingMonth, 6);
  assertEquals(s.listingsNeeded, 1667);
  assertEquals(s.viewsPer30d, 125); // only a and b are 30+ days old: 250 views / 2
  assertEquals(s.zeroViewShare30d, 0);
  assertEquals(s.saleShare60d, null); // nobody is 60 days old yet
  assertEquals(s.medianDaysToFirstSale, 21); // a: 35 days, c: 7 days → median 21
});

Deno.test("scorecard: a sale older than the stats window still counts as the first sale", () => {
  const listings = [{ id: "a", section: "texas", status: "published", published_at: ago(180) }];
  const recent = [{ listing_id: "a", day: dayAgo(10), views: 40, favorites: 2, orders: 1, profit_cents: 600 }];
  const sales = [{ listing_id: "a", day: dayAgo(179), orders: 1 }, { listing_id: "a", day: dayAgo(10), orders: 1 }];
  const s = scorecard(listings, recent, now, sales);
  assertEquals(s.medianDaysToFirstSale, 1);
  assertEquals(s.saleShare60d, 1);
  assertEquals(s.conversion, 0.025); // rolling metrics still use only the recent window
});

Deno.test("scorecard: a sale on the publish day is 0 days, whatever the publish time", () => {
  const listings = [{ id: "a", section: "texas", status: "published", published_at: "2026-11-18T18:00:00Z" }];
  const sales = [{ listing_id: "a", day: "2026-11-18", orders: 1 }];
  assertEquals(scorecard(listings, [], now, sales).medianDaysToFirstSale, 0);
});

Deno.test("bySection: an all key plus one per section present", () => {
  const listings = [
    { id: "a", section: "texas", status: "published", published_at: ago(40) },
    { id: "c", section: "cars", status: "published", published_at: ago(10) },
  ];
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = bySection(listings, [], now);
  assertEquals(Object.keys(out).sort(), ["all", "cars", "texas"]);
  assertEquals(out.all.listings, 2);
  assertEquals(out.texas.listings, 1);
});

Deno.test("fetchAll: pages past Supabase's 1,000-row cap", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ i }));
  const calls: number[][] = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null });
  };
  const out = await fetchAll(page);
  assertEquals(out.data!.length, 2500);
  assertEquals(out.error, null);
  assertEquals(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
});

Deno.test("fetchAll: stops and reports the first error", async () => {
  const out = await fetchAll(() => Promise.resolve({ data: null, error: { message: "boom" } }));
  assertEquals(out.error, { message: "boom" });
});

Deno.test("latestPerAgent: keeps each agent's newest run, even behind many runs of another", () => {
  const busy = Array.from({ length: 300 }, (_, i) => ({ agent: "publisher", status: "ok", started_at: ago(i / 100) }));
  const quiet = [{ agent: "scout", status: "failed", started_at: ago(6) }, { agent: "scout", status: "ok", started_at: ago(13) }];
  const out = latestPerAgent([...quiet, ...busy]);
  assertEquals(out.map((r: { agent: string }) => r.agent).sort(), ["publisher", "scout"]);
  assertEquals(out.find((r: { agent: string }) => r.agent === "scout").status, "failed");
  assertEquals(out.find((r: { agent: string }) => r.agent === "publisher").started_at, ago(0));
});

Deno.test("fmt: formats each kind", () => {
  assertEquals(fmt(0.051, "pct"), "5.1%");
  assertEquals(fmt(6, "usd"), "$6.00");
  assertEquals(fmt(1667, "int"), "1,667");
  assertEquals(fmt(21, "days"), "21 d");
});

/* ---------- KDP books ---------- */
// 2026-11-21 is a Saturday, 2026-11-22 a Sunday.
Deno.test("kdpSlotsUsed: the week resets at Sunday 00:00 UTC", () => {
  const sat = "2026-11-21T23:59:00Z", sun = "2026-11-22T00:00:00Z";
  assertEquals(kdpSlotsUsed([sat, sun], "2026-11-22T10:00:00Z"), 1);
  // Review Focus 4: Sat 23:59 stops counting at Sun 00:00; Sun 00:00 counts from that instant.
  assertEquals(kdpSlotsUsed([sat], "2026-11-22T00:00:00Z"), 0);
  assertEquals(kdpSlotsUsed([sun], "2026-11-22T00:00:00Z"), 1);
  assertEquals(kdpSlotsUsed([sat], "2026-11-21T23:59:30Z"), 1); // still Saturday: same week
  assertEquals(kdpSlotsUsed([sun], "2026-11-28T23:59:59Z"), 1); // next Saturday: same week
  assertEquals(kdpSlotsUsed([sun], "2026-11-29T00:00:00Z"), 0); // next Sunday: reset
  assertEquals(kdpSlotsUsed([null, "", sun], "2026-11-23T08:00:00Z"), 1);
});

Deno.test("bookDecisionUpdate: approve, reject, tweak with pages", () => {
  const now = "2026-11-20T12:00:00Z";
  assertEquals(bookDecisionUpdate("approved", "", [], now), { review: "approved", status: "approved" });
  assertEquals(bookDecisionUpdate("rejected", "", [], now), { review: "rejected", status: "rejected" });
  assertEquals(bookDecisionUpdate("tweak", "  too busy ", [3, 9], now),
    { review: "tweak", status: "redraw", owner_note: "too busy", redraw_pages: [3, 9] });
  assertThrows(() => bookDecisionUpdate("tweak", "too busy", [], now), Error, "Say which pages to redraw.");
  assertThrows(() => bookDecisionUpdate("tweak", "ab", [3], now), Error, "Say what to change (a few words).");
  assertThrows(() => bookDecisionUpdate("maybe", "", [], now), Error, "Unknown decision.");
});

Deno.test("parsePageList: in range, no repeats", () => {
  assertEquals(parsePageList("7, 22,22, 41", 40), [7, 22]);
  assertEquals(parsePageList("7, 22,22, 41"), [7, 22]);
  assertEquals(parsePageList("3 9", 40), [3, 9]);
  assertEquals(parsePageList("0, -2, 2.5, x, 40", 40), [40]);
  assertEquals(parsePageList("", 40), []);
});

Deno.test("uploadKit: KDP entry order, 7 keywords, AI disclosure last", () => {
  const book = { title: "T", subtitle: "S", description: "D", keywords: ["a", "b", "c"], categories: ["X > Y", "Z"] };
  const kit = uploadKit(book, { kdp_brand: "Lost Pines Trading Post" });
  assertEquals(kit.slice(0, 4).map((r: { label: string }) => r.label), ["Title", "Subtitle", "Author", "Description"]);
  assertEquals(kit[2].value, "Lost Pines Trading Post");
  const kw = kit.filter((r: { label: string }) => r.label.startsWith("Keyword "));
  assertEquals(kw.length, 7);
  assertEquals(kw.map((r: { value: string }) => r.value), ["a", "b", "c", "", "", "", ""]);
  assertEquals(kit[11], { label: "Categories", value: "X > Y\nZ" });
  assertEquals(kit.slice(12).map((r: { label: string; value: string }) => r.label + ": " + r.value), [
    "ISBN: free KDP ISBN", "Interior: black & white, white paper", "Trim: 8.5 × 11 in, no bleed", "Cover: matte",
    "AI-generated content: Yes — images and text"]);
});
