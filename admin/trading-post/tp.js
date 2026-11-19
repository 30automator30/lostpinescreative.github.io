/* ============================================================
 * Lost Pines Trading Post — owner page (Queue · Scorecard · Crew)
 * Owner-only (dd_is_admin, enforced by RLS on every tp_ table). Same
 * Supabase project and sign-in as the Command Center.
 * ============================================================ */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { initAuth, isRecovering } from "/portal-auth.js";
import { bySection, canApprove, decisionUpdate, fmt, validateDecision } from "./tp-lib.js";

const CFG = window.LPC_CONFIG || {};
const CONFIGURED = CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf("REPLACE_ME") === -1;
const sb = CONFIGURED ? createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
const REDIRECT = location.origin + "/admin/trading-post/";
const $ = (id) => document.getElementById(id);
const SECTION = { texas: "Texas", christian: "Christian", cars: "Cars & Motorcycles", engineering: "Engineering", outdoors: "Outdoors" };
const METHOD = { svg: "text design", raster: "illustration", pattern: "pattern" };

let user = null, channel = null, tweakId = null;

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function showView(id) { document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id)); window.scrollTo({ top: 0 }); }
function toast(msg, kind) { const el = $("toast"); el.textContent = msg; el.className = "toast show" + (kind ? " " + kind : ""); clearTimeout(toast._t); toast._t = setTimeout(() => (el.className = "toast"), 3000); }
const one = (x) => (Array.isArray(x) ? x[0] : x) || null;
const when = (ts) => (ts ? new Date(ts).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "");

/* ---------- boot ---------- */
if (!CONFIGURED) {
  showView("view-auth"); $("auth-error").textContent = "Not connected.";
  $("auth-form").querySelectorAll("input,button").forEach((el) => (el.disabled = true));
} else {
  initAuth(sb, REDIRECT);
  sb.auth.getSession().then(({ data }) => routeSession(data.session));
  sb.auth.onAuthStateChange((_e, s) => { setTimeout(() => routeSession(s), 0); });
}

async function routeSession(session) {
  if (isRecovering()) return;
  if (!session || !session.user) { user = null; $("signout").style.display = "none"; $("who").textContent = ""; teardown(); showView("view-auth"); return; }
  if (user && user.id === session.user.id) return;
  user = session.user; $("who").textContent = user.email; $("signout").style.display = "";
  const { data: me } = await sb.from("dd_profiles").select("is_admin").eq("id", user.id).single();
  if (!me || !me.is_admin) { showView("view-denied"); return; }
  showView("view-dash");
  selectTab((location.hash || "#queue").slice(1));
  await Promise.all([loadQueue(), loadScorecard(), loadCrew()]);
  subscribe();
}
$("signout").addEventListener("click", () => sb.auth.signOut());
$("denied-out").addEventListener("click", () => sb.auth.signOut());

/* ---------- tabs ---------- */
const TABS = ["queue", "scorecard", "crew"];
function selectTab(name) {
  if (!TABS.includes(name)) name = "queue";
  for (const t of TABS) {
    $("tab-" + t).setAttribute("aria-selected", String(t === name));
    $("panel-" + t).hidden = t !== name;
  }
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
}
TABS.forEach((t) => $("tab-" + t).addEventListener("click", () => selectTab(t)));
window.addEventListener("hashchange", () => selectTab(location.hash.slice(1)));

/* ---------- queue: ideas ---------- */
async function loadQueue() { await Promise.all([loadIdeas(), loadDesigns()]); }

async function loadIdeas() {
  const box = $("q-ideas");
  const { data, error } = await sb.from("tp_concepts")
    .select("id,phrase,visual,method,created_at,niche:tp_niches(section,name)")
    .eq("review", "pending").order("created_at").limit(100);
  if (error) { box.innerHTML = '<div class="empty">Couldn\'t load ideas: ' + esc(error.message) + "</div>"; return; }
  $("q-ideas-n").textContent = data.length ? "(" + data.length + ")" : "";
  if (!data.length) { box.innerHTML = '<div class="empty">No new ideas.</div>'; return; }
  box.innerHTML = data.map((c) => {
    const n = one(c.niche) || {};
    return '<div class="card idea" data-card="c-' + c.id + '"><div class="i-main">' +
      '<div class="meta">' + esc(SECTION[n.section] || n.section || "") + (n.name ? " · " + esc(n.name) : "") + " · " + esc(METHOD[c.method] || c.method) + "</div>" +
      '<div class="i-phrase">' + esc(c.phrase) + "</div>" +
      (c.visual ? '<div class="meta">' + esc(c.visual) + "</div>" : "") + "</div>" +
      '<div class="yesno">' +
      '<button class="btn btn-ghost" data-concept="' + c.id + '" data-d="rejected" aria-label="Reject idea: ' + esc(c.phrase) + '">✗</button>' +
      '<button class="btn btn-primary" data-concept="' + c.id + '" data-d="approved" aria-label="Approve idea: ' + esc(c.phrase) + '">✓</button>' +
      "</div></div>";
  }).join("");
  box.querySelectorAll("[data-concept]").forEach((b) => b.addEventListener("click", () => decide("concept", b.dataset.concept, b.dataset.d, "")));
}

/* ---------- queue: designs ---------- */
async function loadDesigns() {
  const box = $("q-list");
  const { data, error } = await sb.from("tp_designs")
    .select("id,method,compliance,compliance_notes,mockup_path,preview_path,created_at," +
      "concept:tp_concepts(phrase,niche:tp_niches(section,name)),listing:tp_listings(title,tags,price_cents)")
    .eq("review", "pending").neq("compliance", "block").order("created_at").limit(50);
  if (error) { box.innerHTML = '<div class="empty">Couldn\'t load designs: ' + esc(error.message) + "</div>"; return; }
  $("q-designs-n").textContent = data.length ? "(" + data.length + ")" : "";
  if (!data.length) { box.innerHTML = '<div class="empty">Nothing to review. The crew is quiet.</div>'; return; }

  const paths = data.map((d) => d.mockup_path || d.preview_path).filter(Boolean);
  const urls = {};
  if (paths.length) {
    const { data: signed } = await sb.storage.from("tp-designs").createSignedUrls(paths, 3600);
    (signed || []).forEach((s) => { if (s.signedUrl) urls[s.path] = s.signedUrl; });
  }

  box.innerHTML = data.map((d) => {
    const c = one(d.concept) || {}, n = one(c.niche) || {}, l = one(d.listing) || {};
    const img = urls[d.mockup_path || d.preview_path];
    const ok = canApprove(d);
    return '<div class="card design" data-card="d-' + d.id + '">' +
      (img ? '<img src="' + esc(img) + '" alt="Mockup: ' + esc(c.phrase || "design") + '" loading="lazy">' : '<div class="noimg">no image yet</div>') +
      "<div>" +
      '<div class="meta">' + esc(SECTION[n.section] || n.section || "") + (n.name ? " · " + esc(n.name) : "") + "</div>" +
      '<div class="d-title">' + esc(l.title || c.phrase || "Untitled") + "</div>" +
      (l.title && c.phrase ? '<div class="meta">' + esc(c.phrase) + "</div>" : "") +
      (l.tags && l.tags.length ? '<div class="tags">' + l.tags.map((t) => "<span>" + esc(t) + "</span>").join("") + "</div>" : "") +
      (d.compliance === "flag" ? '<div class="flag">Flagged: ' + esc(d.compliance_notes || "check before approving") + "</div>" : "") +
      (d.compliance === "pending" ? '<div class="meta">Compliance check not run yet.</div>' : "") +
      '<div class="d-actions">' +
      '<button class="btn btn-primary" data-design="' + d.id + '" data-d="approved"' + (ok ? "" : " disabled") + ">Approve</button>" +
      '<button class="btn btn-ghost" data-design="' + d.id + '" data-d="tweak">Tweak</button>' +
      '<button class="btn btn-danger" data-design="' + d.id + '" data-d="rejected">Reject</button>' +
      "</div></div></div>";
  }).join("");
  box.querySelectorAll("[data-design]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.d === "tweak") return openTweak(b.dataset.design);
    decide("design", b.dataset.design, b.dataset.d, "");
  }));
}

/* ---------- decisions ---------- */
async function decide(kind, id, decision, note) {
  const err = validateDecision(kind, decision, note);
  if (err) return err;
  const card = document.querySelector('[data-card="' + (kind === "concept" ? "c-" : "d-") + id + '"]');
  if (card) card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const { values, match } = decisionUpdate(decision, note, new Date().toISOString());
  const { data, error } = await sb.from(kind === "concept" ? "tp_concepts" : "tp_designs")
    .update(values).eq("id", id).match(match).select("id");
  if (error) { toast(error.message, "err"); if (card) card.querySelectorAll("button").forEach((b) => (b.disabled = false)); return error.message; }
  if (card) card.remove();
  toast(!data.length ? "Already decided." : decision === "approved" ? "Approved." : decision === "tweak" ? "Sent back to the Designer." : "Rejected.", data.length ? "ok" : "");
  loadQueue();
  return null;
}

function openTweak(id) { tweakId = id; $("tw-note").value = ""; $("tw-error").textContent = ""; $("tw-modal").classList.add("show"); $("tw-note").focus(); }
function closeTweak() { tweakId = null; $("tw-modal").classList.remove("show"); }
$("tw-cancel").addEventListener("click", closeTweak);
$("tw-modal").addEventListener("click", (e) => { if (e.target === $("tw-modal")) closeTweak(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && tweakId) closeTweak(); });
$("tw-save").addEventListener("click", async () => {
  const id = tweakId, note = $("tw-note").value;
  const err = validateDecision("design", "tweak", note);
  if (err) { $("tw-error").textContent = err; return; }
  closeTweak();
  await decide("design", id, "tweak", note);
});

/* ---------- scorecard ---------- */
async function loadScorecard() {
  const box = $("sc-body");
  const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const [lr, sr] = await Promise.all([
    sb.from("tp_listings").select("id,status,published_at,design:tp_designs(concept:tp_concepts(niche:tp_niches(section)))"),
    sb.from("tp_listing_stats").select("listing_id,day,views,favorites,orders,profit_cents").gte("day", since),
  ]);
  if (lr.error || sr.error) { box.innerHTML = '<div class="empty">Couldn\'t load the scorecard: ' + esc((lr.error || sr.error).message) + "</div>"; return; }
  const listings = lr.data.map((l) => {
    const d = one(l.design) || {}, c = one(d.concept) || {}, n = one(c.niche) || {};
    return { id: l.id, status: l.status, published_at: l.published_at, section: n.section || "unknown" };
  });
  if (!listings.some((l) => l.status === "published")) { box.innerHTML = '<div class="empty">No published listings yet.</div>'; return; }
  const sc = bySection(listings, sr.data, new Date());
  const rows = ["all", ...Object.keys(SECTION)].filter((k) => sc[k] && sc[k].listings);
  const COLS = [["listings", "Listings", "int"], ["viewsPer30d", "Views / listing (30d)", "int"], ["favoriteRate", "Favorite rate", "pct"],
    ["zeroViewShare30d", "Zero-view share", "pct"], ["conversion", "Conversion", "pct"], ["saleShare60d", "With a sale (60d)", "pct"],
    ["medianDaysToFirstSale", "Days to first sale", "days"], ["profitPerSale", "Profit / sale", "usd"],
    ["profitPerListingMonth", "Profit / listing / mo", "usd"], ["listingsNeeded", "Listings for $10K", "int"]];
  box.innerHTML = '<div class="sc-wrap"><table class="sc"><thead><tr><th scope="col">Section</th>' +
    COLS.map((c) => '<th scope="col">' + c[1] + "</th>").join("") + "</tr></thead><tbody>" +
    rows.map((k) => '<tr><th scope="row">' + esc(k === "all" ? "All" : SECTION[k]) + "</th>" +
      COLS.map((c) => "<td>" + fmt(sc[k][c[0]], c[2]) + "</td>").join("") + "</tr>").join("") +
    "</tbody></table></div>";
}

/* ---------- crew ---------- */
async function loadCrew() {
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const [rr, cr, st] = await Promise.all([
    sb.from("tp_agent_runs").select("agent,status,started_at,finished_at,summary").order("started_at", { ascending: false }).limit(200),
    sb.from("tp_agent_runs").select("cost_cents").gte("started_at", monthStart.toISOString()),
    sb.from("tp_settings").select("monthly_cap_cents").single(),
  ]);
  const capBox = $("crew-cap"), list = $("crew-list");
  if (rr.error || cr.error || st.error) { list.innerHTML = '<div class="empty">Couldn\'t load the crew: ' + esc((rr.error || cr.error || st.error).message) + "</div>"; capBox.textContent = ""; return; }
  const spent = cr.data.reduce((t, r) => t + (r.cost_cents || 0), 0) / 100;
  const cap = (st.data.monthly_cap_cents || 0) / 100;
  capBox.innerHTML = '<span class="cap">' + fmt(spent, "usd") + "</span> of " + fmt(cap, "usd") + " cap " +
    (cap > 0 && spent >= cap ? '<span class="st over">cap reached: agents stopped</span>' : "");
  const latest = [];
  const seen = new Set();
  for (const r of rr.data) if (!seen.has(r.agent)) { seen.add(r.agent); latest.push(r); }
  if (!latest.length) { list.innerHTML = '<div class="empty">No agent runs yet. The crew starts in Phase 2.</div>'; return; }
  list.innerHTML = latest.map((r) =>
    '<div class="card crew-row"><div class="c-main"><b>' + esc(r.agent) + "</b>" +
    '<div class="meta">' + esc(when(r.finished_at || r.started_at)) + "</div>" +
    (r.summary ? '<div class="meta" style="white-space:pre-wrap;margin-top:4px">' + esc(r.summary) + "</div>" : "") +
    '</div><span class="st ' + esc(r.status) + '">' + esc(r.status) + "</span></div>").join("");
}

/* ---------- realtime ---------- */
function subscribe() {
  if (channel) return;
  channel = sb.channel("tp-admin")
    .on("postgres_changes", { event: "*", schema: "public", table: "tp_concepts" }, loadIdeas)
    .on("postgres_changes", { event: "*", schema: "public", table: "tp_designs" }, loadDesigns)
    .on("postgres_changes", { event: "*", schema: "public", table: "tp_agent_runs" }, loadCrew)
    .subscribe();
}
function teardown() { if (channel) { sb.removeChannel(channel); channel = null; } }
