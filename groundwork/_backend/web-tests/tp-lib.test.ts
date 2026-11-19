// Unit tests for /admin/trading-post/tp-lib.js (Trading Post approval + KPI math).
// Run: deno test -A groundwork/_backend/web-tests/
import { assertEquals } from "jsr:@std/assert@1";
// @ts-ignore plain JS module served by the site
import { bySection, canApprove, decisionUpdate, fetchAll, fmt, scorecard, validateDecision } from "../../../admin/trading-post/tp-lib.js";

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

Deno.test("fmt: formats each kind", () => {
  assertEquals(fmt(0.051, "pct"), "5.1%");
  assertEquals(fmt(6, "usd"), "$6.00");
  assertEquals(fmt(1667, "int"), "1,667");
  assertEquals(fmt(21, "days"), "21 d");
});
