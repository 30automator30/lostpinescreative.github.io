/* Lost Pines Trading Post — pure helpers for the owner page (no I/O).
 * Tested in groundwork/_backend/web-tests/tp-lib.test.ts. */

const DAY = 86400000;
const TARGET_MONTHLY_PROFIT = 10000;

export function canApprove(design) {
  return design.compliance === "pass" || design.compliance === "flag";
}

export function validateDecision(kind, decision, note) {
  if (decision === "approved" || decision === "rejected") return null;
  if (decision === "regenerate" && kind === "concept") return null;
  if ((decision === "tweak" && kind === "design") || (decision === "revise" && kind === "concept")) {
    return (note || "").trim().length >= 3 ? null : "Say what to change (a few words).";
  }
  return "Unknown decision.";
}

export function decisionUpdate(decision, note, nowIso) {
  const n = (note || "").trim();
  return { values: { review: decision, owner_note: n || null, reviewed_at: nowIso }, match: { review: "pending" } };
}

/* Supabase returns at most 1,000 rows per request. page(from, to) runs one ranged query. */
export async function fetchAll(page, size = 1000) {
  const all = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) return { data: null, error };
    all.push(...data);
    if (data.length < size) return { data: all, error: null };
  }
}

/* Newest run per agent, whatever order the rows arrive in. */
export function latestPerAgent(runs) {
  const best = new Map();
  for (const r of runs) {
    const cur = best.get(r.agent);
    if (!cur || Date.parse(r.started_at) > Date.parse(cur.started_at)) best.set(r.agent, r);
  }
  return [...best.values()].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

const ratio = (a, b) => (b > 0 ? a / b : null);
const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);

/* stats: the recent window (rolling metrics). sales: all-time rows with orders > 0 (first-sale metrics). */
export function scorecard(listings, stats, now, sales = stats) {
  const t = now.getTime();
  const pub = listings.filter((l) => l.status === "published");
  if (!pub.length) {
    return { listings: null, viewsPer30d: null, favoriteRate: null, zeroViewShare30d: null, conversion: null,
      saleShare60d: null, medianDaysToFirstSale: null, profitPerSale: null, profitPerListingMonth: null, listingsNeeded: null };
  }
  const ids = new Set(pub.map((l) => l.id));
  const st = stats.filter((s) => ids.has(s.listing_id));
  const sold = sales.filter((s) => ids.has(s.listing_id));
  const recent = st.filter((s) => Date.parse(s.day + "T00:00:00Z") >= t - 30 * DAY);
  const age = (l) => (t - Date.parse(l.published_at)) / DAY;
  const of = (rows, id) => rows.filter((s) => s.listing_id === id);

  const c30 = pub.filter((l) => age(l) >= 30);
  const c60 = pub.filter((l) => age(l) >= 60);
  const views = sum(st, "views"), orders = sum(st, "orders");

  const firstSale = pub.map((l) => {
    const days = of(sold, l.id).filter((s) => s.orders > 0).map((s) => Date.parse(s.day + "T00:00:00Z")).sort((a, b) => a - b);
    // Stats days are UTC dates, so compare against the publish date, not its time of day.
    const pubDay = Date.parse(String(l.published_at).slice(0, 10) + "T00:00:00Z");
    return days.length ? Math.round((days[0] - pubDay) / DAY) : null;
  }).filter((d) => d !== null).sort((a, b) => a - b);
  const mid = firstSale.length >> 1;
  const median = !firstSale.length ? null
    : firstSale.length % 2 ? firstSale[mid] : (firstSale[mid - 1] + firstSale[mid]) / 2;

  const pplm = sum(recent, "profit_cents") / 100 / pub.length;
  return {
    listings: pub.length,
    viewsPer30d: ratio(c30.reduce((tot, l) => tot + sum(of(recent, l.id), "views"), 0), c30.length),
    favoriteRate: ratio(sum(st, "favorites"), views),
    zeroViewShare30d: ratio(c30.filter((l) => sum(of(recent, l.id), "views") === 0).length, c30.length),
    conversion: ratio(orders, views),
    saleShare60d: ratio(c60.filter((l) => sum(of(sold, l.id), "orders") > 0).length, c60.length),
    medianDaysToFirstSale: median,
    profitPerSale: ratio(sum(st, "profit_cents") / 100, orders),
    profitPerListingMonth: pplm,
    listingsNeeded: pplm > 0 ? Math.ceil(TARGET_MONTHLY_PROFIT / pplm) : null,
  };
}

export function bySection(listings, stats, now, sales = stats) {
  const out = { all: scorecard(listings, stats, now, sales) };
  for (const sec of new Set(listings.map((l) => l.section))) {
    out[sec] = scorecard(listings.filter((l) => l.section === sec), stats, now, sales);
  }
  return out;
}

export function fmt(n, kind) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (kind === "pct") return (n * 100).toFixed(1) + "%";
  if (kind === "usd") return "$" + n.toFixed(2);
  if (kind === "days") return Math.round(n) + " d";
  return Math.round(n).toLocaleString("en-US");
}

/* ---------- KDP books ---------- */

/* KDP's weekly title limit resets at Sunday 00:00 UTC: count submissions since then. */
export function kdpSlotsUsed(submittedAts, nowIso) {
  const now = new Date(nowIso);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - now.getUTCDay() * DAY;
  return submittedAts.filter((s) => s && Date.parse(s) >= start).length;
}

/* "7, 22,22, 41" -> [7, 22]: whole numbers 1..max, no repeats, ascending. */
export function parsePageList(text, max = 40) {
  const ok = String(text || "").split(/[\s,]+/).filter((s) => /^\d+$/.test(s)).map(Number).filter((n) => n >= 1 && n <= max);
  return [...new Set(ok)].sort((a, b) => a - b);
}

/* Values for kdp_books. kdp_books has no reviewed_at column (migration 008), so nowIso is unused. */
export function bookDecisionUpdate(decision, note, pages, _nowIso) {
  if (decision === "approved" || decision === "rejected") return { review: decision, status: decision };
  if (decision !== "tweak") throw new Error("Unknown decision.");
  const n = (note || "").trim();
  if (n.length < 3) throw new Error("Say what to change (a few words).");
  if (!pages || !pages.length) throw new Error("Say which pages to redraw.");
  return { review: "tweak", status: "redraw", owner_note: n, redraw_pages: pages };
}

/* Every KDP field in the order KDP's paperback form asks for it. */
export function uploadKit(book, settings) {
  const kw = book.keywords || [];
  return [
    { label: "Title", value: book.title || "" },
    { label: "Subtitle", value: book.subtitle || "" },
    { label: "Author", value: (settings && settings.kdp_brand) || "" },
    { label: "Description", value: book.description || "" },
    ...Array.from({ length: 7 }, (_, i) => ({ label: "Keyword " + (i + 1), value: kw[i] || "" })),
    { label: "Categories", value: (book.categories || []).join("\n") },
    { label: "ISBN", value: "free KDP ISBN" },
    { label: "Interior", value: "black & white, white paper" },
    { label: "Trim", value: "8.5 × 11 in, no bleed" },
    { label: "Cover", value: "matte" },
    { label: "AI-generated content", value: "Yes — images and text" },
  ];
}
