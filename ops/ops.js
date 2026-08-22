/* ============================================================
 * Lost Pines Creative — internal Ops dashboard (admin-only)
 * Company assets: domains, services, app stores, analytics, accounts, repos —
 * with cost, cadence, renewal tracking, and total burn. Email+password auth,
 * gated on dd_is_admin. Shares the DeSmit/Groundwork Supabase project.
 * ============================================================ */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { initAuth, isRecovering } from "/portal-auth.js";

const CFG = window.LPC_CONFIG || {};
const CONFIGURED = CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf("REPLACE_ME") === -1;
const sb = CONFIGURED ? createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
const REDIRECT = CFG.REDIRECT || (location.origin + location.pathname);
const $ = (id) => document.getElementById(id);

const CAT_ORDER = ["domain", "service", "app_store", "analytics", "account", "repo", "other"];
const CAT_LABEL = { domain: "Domains", service: "Services & infrastructure", app_store: "App stores & commerce", analytics: "Analytics", account: "Accounts", repo: "Repositories", other: "Other" };
const CADENCE_SUFFIX = { monthly: "/mo", yearly: "/yr", one_time: " once", usage: " usage", free: "" };

let user = null, channel = null, editingId = null, assets = [];

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function money(n) { return n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function showView(id) { document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id)); window.scrollTo({ top: 0 }); }
function toast(msg, kind) { const el = $("toast"); if (!el) return; el.textContent = msg; el.className = "toast show" + (kind ? " " + kind : ""); clearTimeout(toast._t); toast._t = setTimeout(() => (el.className = "toast"), 3000); }
function fmtDate(d) { if (!d) return ""; return new Date(d + "T00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
function daysUntil(d) { if (!d) return Infinity; return Math.round((new Date(d + "T00:00") - Date.now()) / 86400000); }

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
  enterDash();
}
$("signout").addEventListener("click", () => sb.auth.signOut());
$("denied-out").addEventListener("click", () => sb.auth.signOut());

/* ---------- dashboard ---------- */
async function enterDash() { showView("view-dash"); await load(); subscribe(); }

async function load() {
  const { data, error } = await sb.from("lpc_assets").select("*").order("category").order("sort").order("name");
  if (error) { $("asset-groups").innerHTML = '<div class="empty">Couldn\'t load assets.</div>'; return; }
  assets = data || [];
  renderStats(); renderGroups();
}

function renderStats() {
  let monthly = 0;
  for (const a of assets) {
    if (a.cost == null || a.status === "cancelled") continue;
    if (a.cadence === "monthly") monthly += Number(a.cost);
    else if (a.cadence === "yearly") monthly += Number(a.cost) / 12;
  }
  $("st-monthly").textContent = "$" + monthly.toFixed(0);
  $("st-yearly").textContent = "$" + (monthly * 12).toFixed(0);
  const soon = assets.filter((a) => a.status !== "cancelled" && a.renews_at && daysUntil(a.renews_at) <= 30).length;
  $("st-soon").textContent = String(soon);
}

function renderGroups() {
  const box = $("asset-groups");
  if (!assets.length) { box.innerHTML = '<div class="empty">No assets yet. Click <b>Add asset</b>.</div>'; return; }
  let html = "";
  for (const cat of CAT_ORDER) {
    const rows = assets.filter((a) => a.category === cat);
    if (!rows.length) continue;
    html += '<div class="cat-head">' + CAT_LABEL[cat] + "</div>";
    html += rows.map(assetRow).join("");
  }
  box.innerHTML = html;
  box.querySelectorAll("[data-edit]").forEach((el) => el.addEventListener("click", () => openEdit(el.dataset.edit)));
  box.querySelectorAll("[data-renew]").forEach((b) => b.addEventListener("click", async (e) => { e.stopPropagation(); await renew(b.dataset.renew); }));
}

function assetRow(a) {
  const d = daysUntil(a.renews_at);
  const soon = a.renews_at && d <= 30 && a.status !== "cancelled";
  const costTxt = a.cadence === "free" ? "free" : (a.cost != null ? money(a.cost) + (CADENCE_SUFFIX[a.cadence] || "") : (a.cadence === "usage" ? "usage" : "—"));
  return '<div class="asset ' + (soon ? "soon" : "") + '" data-edit="' + a.id + '" style="cursor:pointer">' +
    '<div class="a-main"><b>' + esc(a.name) + "</b>" +
    '<div class="a-sub">' + esc(a.provider || "") + (a.status !== "active" ? " · " + esc(a.status) : "") +
    (a.url ? ' · <a href="' + esc(a.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">open</a>' : "") + "</div></div>" +
    '<div class="a-cost">' + costTxt + "</div>" +
    '<div class="a-renew ' + (soon ? "soon" : "") + '">' + (a.renews_at ? "renews " + fmtDate(a.renews_at) + (d < 0 ? " (overdue)" : d <= 30 ? " (" + d + "d)" : "") : "") + "</div>" +
    (a.renews_at && (a.cadence === "monthly" || a.cadence === "yearly")
      ? '<div class="a-actions"><button class="btn btn-ghost btn-sm" data-renew="' + a.id + '" title="Mark renewed">✓ renewed</button></div>' : "") +
    "</div>";
}

async function renew(id) {
  const a = assets.find((x) => x.id === id); if (!a || !a.renews_at) return;
  const dt = new Date(a.renews_at + "T00:00");
  if (a.cadence === "yearly") dt.setFullYear(dt.getFullYear() + 1);
  else dt.setMonth(dt.getMonth() + 1);
  const next = dt.toISOString().slice(0, 10);
  const { error } = await sb.from("lpc_assets").update({ renews_at: next }).eq("id", id);
  if (error) { toast(error.message, "err"); return; }
  toast("Renewal advanced to " + fmtDate(next), "ok"); load();
}

/* ---------- add / edit ---------- */
$("add-asset").addEventListener("click", () => openEdit(null));
$("edit-cancel").addEventListener("click", () => $("edit-modal").classList.remove("show"));
$("edit-modal").addEventListener("click", (e) => { if (e.target === $("edit-modal")) $("edit-modal").classList.remove("show"); });

function openEdit(id) {
  editingId = id;
  const a = id ? assets.find((x) => x.id === id) : {};
  $("edit-title").textContent = id ? "Edit asset" : "Add asset";
  $("e-name").value = a.name || ""; $("e-provider").value = a.provider || "";
  $("e-category").value = a.category || "service"; $("e-status").value = a.status || "active";
  $("e-cost").value = a.cost != null ? a.cost : ""; $("e-cadence").value = a.cadence || "monthly";
  $("e-renews").value = a.renews_at || ""; $("e-url").value = a.url || ""; $("e-notes").value = a.notes || "";
  $("edit-error").textContent = "";
  $("edit-delete").style.display = id ? "" : "none";
  $("edit-modal").classList.add("show");
}

$("edit-save").addEventListener("click", async () => {
  const name = $("e-name").value.trim();
  if (!name) { $("edit-error").textContent = "Name is required."; return; }
  const btn = $("edit-save"); btn.disabled = true; $("edit-error").textContent = "";
  const payload = {
    name, provider: $("e-provider").value.trim() || null, category: $("e-category").value,
    status: $("e-status").value, cost: $("e-cost").value === "" ? null : Number($("e-cost").value),
    cadence: $("e-cadence").value, renews_at: $("e-renews").value || null,
    url: $("e-url").value.trim() || null, notes: $("e-notes").value.trim() || null,
  };
  const res = editingId
    ? await sb.from("lpc_assets").update(payload).eq("id", editingId)
    : await sb.from("lpc_assets").insert(payload);
  btn.disabled = false;
  if (res.error) { $("edit-error").textContent = res.error.message; return; }
  $("edit-modal").classList.remove("show"); toast("Saved.", "ok"); load();
});

$("edit-delete").addEventListener("click", async () => {
  if (!editingId) return;
  if (!confirm("Delete this asset?")) return;
  const { error } = await sb.from("lpc_assets").delete().eq("id", editingId);
  if (error) { $("edit-error").textContent = error.message; return; }
  $("edit-modal").classList.remove("show"); toast("Deleted.", "ok"); load();
});

/* ---------- realtime ---------- */
function subscribe() {
  if (channel) return;
  channel = sb.channel("lpc-ops").on("postgres_changes", { event: "*", schema: "public", table: "lpc_assets" }, load).subscribe();
}
function teardown() { if (channel) { sb.removeChannel(channel); channel = null; } }
