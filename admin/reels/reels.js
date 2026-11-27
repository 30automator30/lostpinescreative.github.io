/* ============================================================
 * Reel Studio — owner review of NomadCore reels (Review · Ready to post · In progress)
 * Owner-only: rows are readable only with dd_is_admin (RLS); decisions go through the
 * reel_decide / reel_mark_posted functions. The nightly reel run on the owner's PC acts on them.
 * ============================================================ */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { initAuth, isRecovering } from "/portal-auth.js";

const CFG = window.LPC_CONFIG || {};
const CONFIGURED = CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf("REPLACE_ME") === -1;
const sb = CONFIGURED ? createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
const REDIRECT = location.origin + "/admin/reels/";
const $ = (id) => document.getElementById(id);
const SERIES = { "survival-files": "Survival Files", "how-to": "Prepare For…" };
const PLATFORMS = [["youtube", "YouTube"], ["tiktok", "TikTok"], ["facebook", "Facebook"], ["instagram", "Instagram"], ["x", "X"]];
const WAITING = { approved: "Approved, tonight's run picks it up", revise: "Sent back, tonight's run revises it",
  regenerate: "Regenerate, tonight's run redoes it", working: "The nightly run is working on it" };

let user = null, channel = null, noteFor = null, rows = [], refresher = null;
const RESIGN_MS = 50 * 60 * 1000; // before the 3,600 s signed-URL lifetime runs out

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function showView(id) { document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id)); window.scrollTo({ top: 0 }); }
function toast(msg, kind) { const el = $("toast"); el.textContent = msg; el.className = "toast show" + (kind ? " " + kind : ""); clearTimeout(toast._t); toast._t = setTimeout(() => (el.className = "toast"), 3000); }
const when = (ts) => (ts ? new Date(ts).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "");
const safeUrl = (u) => (/^https:\/\/github\.com\//.test(u || "") ? u : null);

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
  selectTab((location.hash || "#review").slice(1));
  await load();
  subscribe();
  refresher = setInterval(load, 5 * 60 * 1000); // load() itself decides whether the links need re-signing
}
$("signout").addEventListener("click", () => sb.auth.signOut());
$("denied-out").addEventListener("click", () => sb.auth.signOut());

/* ---------- tabs ---------- */
const TABS = ["review", "ready", "pipeline"];
function selectTab(name) {
  if (!TABS.includes(name)) name = "review";
  for (const t of TABS) { $("tab-" + t).setAttribute("aria-selected", String(t === name)); $("panel-" + t).hidden = t !== name; }
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
}
TABS.forEach((t) => $("tab-" + t).addEventListener("click", () => selectTab(t)));
window.addEventListener("hashchange", () => selectTab(location.hash.slice(1)));

/* ---------- data ---------- */
async function signed(paths) {
  paths = paths.filter(Boolean);
  if (!paths.length) return {};
  const { data, error } = await sb.storage.from("reels").createSignedUrls(paths, 3600);
  if (error) { toast("Couldn't load previews: " + error.message, "error"); return null; }
  return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

async function load() {
  const data = [];
  for (let from = 0; ; from += 1000) { // paged: one response is capped at the project's max_rows
    const { data: page, error } = await sb.from("reel_items").select("*").order("updated_at", { ascending: false }).order("id").range(from, from + 999);
    if (error) { toast("Couldn't load reels: " + error.message, "error"); return; }
    data.push(...page);
    if (page.length < 1000) break;
  }
  // Rebuilding the cards restarts any preview video, so only do it when something actually changed.
  const snapshot = JSON.stringify(data);
  // Signed links last an hour, so an unchanged page still re-signs after RESIGN_MS.
  if (snapshot === load.last && Date.now() - load.signedAt < RESIGN_MS) return;
  rows = data;
  const signedUrls = await signed(rows.flatMap((r) => [r.storyboard_path, r.preview_path]));
  // Remember this snapshot only when the previews signed, so a storage hiccup is retried on the next load.
  load.last = signedUrls ? snapshot : null;
  load.signedAt = Date.now();
  const urls = signedUrls || {};
  const review = rows.filter((r) => r.status === "review" && (r.stage === "concept" || r.stage === "final"));
  const ready = rows.filter((r) => r.stage === "ready" || r.stage === "posted");
  const pipeline = rows.filter((r) => r.status !== "review" && (r.stage === "concept" || r.stage === "final"));
  render("list-concept", review.filter((r) => r.stage === "concept"), urls, "No concepts waiting. New ones arrive overnight.");
  render("list-final", review.filter((r) => r.stage === "final"), urls, "No finished reels waiting.");
  render("list-ready", ready, urls, "Nothing ready to post yet.");
  render("list-pipeline", pipeline, urls, "Nothing in progress.");
  $("n-review").textContent = review.length ? `(${review.length})` : "";
  const unposted = ready.filter((r) => r.stage === "ready").length;
  $("n-ready").textContent = unposted ? `(${unposted})` : "";
  $("n-pipeline").textContent = pipeline.length ? `(${pipeline.length})` : "";
}

/* ---------- cards ---------- */
function media(r, urls) {
  if (r.stage !== "concept" && r.preview_path && urls[r.preview_path]) {
    return `<video controls playsinline preload="metadata" src="${esc(urls[r.preview_path])}" aria-label="Preview of ${esc(r.title)}"></video>`;
  }
  if (r.storyboard_path && urls[r.storyboard_path]) {
    return `<button type="button" class="thumb" data-zoom="${esc(r.id)}" aria-label="Open the storyboard for ${esc(r.title)}"><img src="${esc(urls[r.storyboard_path])}" alt="Storyboard: every still in beat order"></button>`;
  }
  return '<div class="noimg">No preview yet</div>';
}

function reviewsHtml(r) {
  const entries = Object.entries(r.reviews || {});
  if (!entries.length) return "";
  return `<div class="reviews">${entries.map(([who, v]) => `<div><b>${esc(who)}:</b> ${esc(v)}</div>`).join("")}</div>`;
}

function actions(r) {
  if (r.stage === "ready" || r.stage === "posted") return "";
  if (r.status !== "review") {
    if (r.status === "working") return `<div class="meta">${esc(WAITING.working)}</div>`;
    if (r.run_now) return `<div class="meta">Starting on the PC within about 10 minutes</div>`;
    return `<div class="meta">${esc(WAITING[r.status] || "")}</div>
      <div class="actions-row"><button class="btn btn-primary btn-sm" data-now="${esc(r.id)}">Do it now</button></div>`;
  }
  if (r.stage === "concept") {
    return `<div class="actions-row">
      <button class="btn btn-primary" data-id="${esc(r.id)}" data-d="approve">Approve</button>
      <button class="btn btn-ghost" data-id="${esc(r.id)}" data-d="revise">Revise…</button>
      <button class="btn btn-ghost" data-id="${esc(r.id)}" data-d="regenerate">Regenerate</button></div>`;
  }
  if (r.stage === "final") {
    return `<div class="actions-row">
      <button class="btn btn-primary" data-id="${esc(r.id)}" data-d="approve">Accept</button>
      <button class="btn btn-ghost" data-id="${esc(r.id)}" data-d="revise">Send back…</button></div>`;
  }
  return "";
}

function postedHtml(r) {
  if (r.stage !== "ready" && r.stage !== "posted") return "";
  const p = r.posted || {};
  return `${r.caption ? `<details><summary>Caption</summary><div class="kv">${esc(r.caption)}</div></details>` : ""}
    <div class="platforms" role="group" aria-label="Mark as posted">${PLATFORMS.map(([k, label]) =>
      `<button class="btn btn-ghost btn-sm" data-post="${esc(r.id)}" data-platform="${k}" aria-pressed="${p[k] ? "true" : "false"}"
        ${p[k] ? `title="Posted ${esc(when(p[k]))}" disabled` : ""}>${p[k] ? "✓ " : ""}${label}</button>`).join("")}</div>`;
}

function render(boxId, list, urls, emptyText) {
  const box = $(boxId);
  if (!list.length) { box.innerHTML = `<div class="empty">${esc(emptyText)}</div>`; return; }
  box.innerHTML = list.map((r) => {
    const pr = safeUrl(r.pr_url);
    return `<article class="card reel">
      <div>${media(r, urls)}</div>
      <div>
        <div class="meta">${esc(SERIES[r.series] || r.series)} #${esc(r.number)} · ${esc(r.stage)} · updated ${esc(when(r.updated_at))}</div>
        <div class="r-title">${esc(r.title)}</div>
        ${r.hook ? `<div class="r-hook">“${esc(r.hook)}”</div>` : ""}
        ${reviewsHtml(r)}
        ${r.agent_note ? `<div class="note">${esc(r.agent_note)}</div>` : ""}
        ${r.owner_note && r.status !== "review" ? `<div class="meta">Your note: ${esc(r.owner_note)}</div>` : ""}
        ${pr ? `<div class="actions-row"><a class="btn btn-ghost btn-sm" href="${esc(pr)}" target="_blank" rel="noopener">Open the PR</a></div>` : ""}
        ${actions(r)}
        ${postedHtml(r)}
      </div>
    </article>`;
  }).join("");
}

/* ---------- decisions ---------- */
async function decide(id, decision, note) {
  const { error } = await sb.rpc("reel_decide", { p_id: id, p_decision: decision, p_note: note || null });
  if (error) { toast(error.message, "error"); return false; }
  toast({ approve: "Approved. Tonight's run takes it, or tap Do it now.", revise: "Sent back. Tonight's run fixes it, or tap Do it now.",
    regenerate: "Tonight's run redoes it, or tap Do it now." }[decision]);
  await load();
  return true;
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.zoom) return openZoom(b.dataset.zoom);
  if (b.dataset.post) {
    b.disabled = true;
    const { error } = await sb.rpc("reel_mark_posted", { p_id: b.dataset.post, p_platform: b.dataset.platform });
    if (error) { b.disabled = false; toast(error.message, "error"); return; }
    toast("Marked as posted."); await load(); return;
  }
  if (b.dataset.now) {
    b.disabled = true;
    const { error } = await sb.rpc("reel_run_now", { p_id: b.dataset.now });
    if (error) { b.disabled = false; toast(error.message, "error"); return; }
    toast("Queued. The PC starts it within about 10 minutes."); await load(); return;
  }
  if (!b.dataset.d) return;
  if (b.dataset.d === "revise") return openNote(b.dataset.id);
  b.disabled = true;
  if (!(await decide(b.dataset.id, b.dataset.d))) b.disabled = false;
});

function openNote(id) {
  const r = rows.find((x) => x.id === id);
  noteFor = id;
  $("note-title").textContent = r && r.stage === "final" ? "What should change in the finished reel?" : "How should this concept change?";
  $("note-text").value = ""; $("note-error").textContent = "";
  $("note-modal").classList.add("show"); $("note-text").focus();
}
function closeNote() { noteFor = null; $("note-modal").classList.remove("show"); }
$("note-cancel").addEventListener("click", closeNote);
$("note-modal").addEventListener("click", (e) => { if (e.target === $("note-modal")) closeNote(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && noteFor) closeNote(); });
$("note-save").addEventListener("click", async () => {
  const note = $("note-text").value.trim();
  if (!note) { $("note-error").textContent = "Say what should change."; return; }
  if (note.length > 2000) { $("note-error").textContent = "Keep it under 2,000 characters."; return; }
  $("note-save").disabled = true;
  const ok = await decide(noteFor, "revise", note);
  $("note-save").disabled = false;
  if (ok) closeNote();
});

/* ---------- storyboard zoom ---------- */
async function openZoom(id) {
  const r = rows.find((x) => x.id === id);
  if (!r) return;
  const urls = (await signed([r.storyboard_path])) || {};
  $("zoom-title").textContent = r.title;
  $("zoom-stage").innerHTML = urls[r.storyboard_path] ? `<img src="${esc(urls[r.storyboard_path])}" alt="Storyboard for ${esc(r.title)}">` : '<div class="empty">No storyboard.</div>';
  $("zoom").showModal();
}
$("zoom-close").addEventListener("click", () => $("zoom").close());

/* ---------- realtime ---------- */
function subscribe() {
  if (channel) return;
  // Debounced: the run often writes a card several times in a row.
  channel = sb.channel("reel-studio").on("postgres_changes", { event: "*", schema: "public", table: "reel_items" }, () => {
    clearTimeout(subscribe._t); subscribe._t = setTimeout(load, 600);
  }).subscribe();
}
function teardown() {
  load.last = null; clearInterval(refresher); refresher = null;
  if (channel) { sb.removeChannel(channel); channel = null; }
}
