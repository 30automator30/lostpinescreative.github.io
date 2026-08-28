/* ============================================================
 * Groundwork — client portal logic
 * Magic-link auth · care plan · integrations · messages · reports ·
 * receptionist/voicemail settings. Live via Supabase Realtime.
 * ============================================================ */
import {
  sb, CONFIGURED, REDIRECT, CARE_LABEL, STATUS_LABEL, INT_STATUS, MSG_KIND,
  money, fmtDate, fmtDateTime, escapeHtml, toast, showView,
  loadClientFiles, uploadClientFiles, deleteAttachment, renderAttachments, wireUploader,
  loadClientUpdates,
} from "./client.js";
import { initAuth, isRecovering } from "/portal-auth.js";

const $ = (id) => document.getElementById(id);
let user = null;
let client = null;      // the user's gw_clients row
let channel = null;

/* ---------- boot ---------- */
if (!CONFIGURED) {
  showView("view-auth");
  $("auth-error").textContent = "The portal isn't connected yet — email ddesmit@lostpinescreative.com in the meantime.";
  $("auth-form").querySelectorAll("input,button").forEach((el) => (el.disabled = true));
} else {
  initAuth(sb, REDIRECT);
  sb.auth.getSession().then(({ data }) => routeSession(data.session));
  // Defer out of the callback — awaiting Supabase inside onAuthStateChange deadlocks.
  sb.auth.onAuthStateChange((_e, s) => { setTimeout(() => routeSession(s), 0); });
}

async function routeSession(session) {
  if (isRecovering()) return;
  if (!session || !session.user) {
    user = null; client = null; teardown();
    $("signout").style.display = "none"; $("who").textContent = "";
    showView("view-auth");
    return;
  }
  if (user && user.id === session.user.id) return;
  user = session.user;
  $("who").textContent = user.email;
  $("signout").style.display = "";
  const em = (user.email || "").toLowerCase();
  const { data, error } = await sb.from("gw_clients").select("*")
    .or(`owner_id.eq.${user.id},owner_email.eq.${em}`).limit(1);
  if (error) { toast("Couldn't load your account.", "err"); return; }
  if (!data || !data.length) { showView("view-none"); return; }
  client = data[0];
  enterDashboard();
}

/* ---------- auth (email + password wired in /portal-auth.js) ---------- */
$("signout").addEventListener("click", () => sb.auth.signOut());
$("none-out").addEventListener("click", () => sb.auth.signOut());

/* ---------- dashboard ---------- */
async function enterDashboard() {
  showView("view-dash");
  renderPlan();
  await Promise.all([loadIntegrations(), loadMessages(), loadSettings(), loadReports(), loadActivity(), loadFiles()]);
  subscribe();
}

/* ---------- activity timeline (read-only) ---------- */
async function loadActivity() {
  const list = await loadClientUpdates(client.id);
  const sect = $("gw-activity-section");
  if (!list.length) { sect.style.display = "none"; return; }
  sect.style.display = "";
  $("gw-updates").innerHTML = list.map((u) =>
    '<li><div class="u-when">' + fmtDateTime(u.created_at) + "</div>" +
    '<div class="u-body">' + escapeHtml(u.body) + "</div></li>").join("");
}

/* ---------- files (client uploads too) ---------- */
async function loadFiles() {
  const files = await loadClientFiles(client.id);
  renderAttachments($("gw-files"), files, {
    canDelete: (a) => a.uploaded_by === user.id,
    showInternal: false,
    onDelete: async (fid) => {
      const f = files.find((x) => x.id === fid);
      if (!f || !confirm("Remove " + (f.filename || "this file") + "?")) return;
      const { ok } = await deleteAttachment(f);
      if (!ok) { toast("Couldn't remove that file.", "err"); return; }
      toast("File removed.", "ok"); loadFiles();
    },
  });
}
wireUploader(document.getElementById("gw-uploader"), document.getElementById("gw-file-input"), async (files) => {
  if (!client) return;
  const zone = $("gw-uploader");
  zone.style.pointerEvents = "none"; zone.style.opacity = ".6";
  const n = await uploadClientFiles(client.id, files);
  zone.style.pointerEvents = ""; zone.style.opacity = "";
  if (n) toast(n === 1 ? "File added." : n + " files added.", "ok");
  loadFiles();
});

function renderPlan() {
  $("pl-biz").textContent = client.business_name;
  $("pl-plan").textContent = CARE_LABEL[client.care_plan] || CARE_LABEL.none;
  const b = $("pl-status");
  b.className = "badge " + (client.status === "active" ? "live" : client.status === "paused" ? "paused" : "planned");
  b.textContent = STATUS_LABEL[client.status] || client.status;
}

async function loadIntegrations() {
  const { data } = await sb.from("gw_integrations").select("*").eq("client_id", client.id)
    .order("sort", { ascending: true }).order("label", { ascending: true });
  const grid = $("int-grid");
  if (!data || !data.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Your system is being set up — tools will appear here as they go live.</div>';
    return;
  }
  grid.innerHTML = data.map((i) =>
    '<div class="int-item"><div class="int-main"><b>' + escapeHtml(i.label) + "</b>" +
    (i.url ? '<a href="' + escapeHtml(i.url) + '" target="_blank" rel="noopener">Open &rarr;</a>'
           : (i.notes ? '<span class="int-sub">' + escapeHtml(i.notes) + "</span>" : "")) +
    '</div><span class="badge ' + i.status + '">' + (INT_STATUS[i.status] || i.status) + "</span></div>"
  ).join("");
}

async function loadMessages() {
  const { data } = await sb.from("gw_messages").select("*").eq("client_id", client.id)
    .order("created_at", { ascending: false });
  const list = $("msg-list");
  const nNew = (data || []).filter((m) => m.status === "new").length;
  $("msg-count").textContent = nNew ? nNew + " new" : "";
  if (!data || !data.length) { list.innerHTML = '<div class="empty">No messages yet.</div>'; return; }
  list.innerHTML = data.map((m) => {
    const who = m.from_name || m.from_phone || m.from_email || "Unknown";
    return '<div class="msg-item ' + (m.status !== "new" ? "handled" : "") + '">' +
      '<div class="msg-top"><span class="badge ' + (m.status === "new" ? "new" : "handled") + '">' + (MSG_KIND[m.kind] || m.kind) + "</span>" +
      "<b>" + escapeHtml(who) + "</b>" +
      (m.from_phone ? ' <span class="subtle">' + escapeHtml(m.from_phone) + "</span>" : "") +
      '<span class="spacer" style="flex:1"></span><span class="msg-when">' + fmtDateTime(m.created_at) + "</span></div>" +
      (m.body ? '<div class="msg-body">' + escapeHtml(m.body) + "</div>" : "") +
      (m.status === "new"
        ? '<div style="text-align:right;margin-top:8px"><button class="btn btn-ghost btn-sm" data-handle="' + m.id + '">Mark handled</button></div>'
        : "") +
      "</div>";
  }).join("");
  list.querySelectorAll("[data-handle]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      const { error } = await sb.rpc("gw_set_message_status", { p_msg: b.dataset.handle, p_status: "handled" });
      if (error) { toast("Couldn't update.", "err"); b.disabled = false; return; }
      loadMessages();
    }));
}

async function loadSettings() {
  const { data } = await sb.from("gw_settings").select("*").eq("client_id", client.id).maybeSingle();
  $("set-greeting").value = (data && data.greeting) || "";
  $("set-forward").value = (data && data.forward_number) || "";
  $("set-hours").value = (data && data.hours && data.hours.text) || "";
  $("set-after").value = (data && data.after_hours) || "";
  $("set-textback").value = (data && data.textback_message) || "";
}
$("set-save").addEventListener("click", async () => {
  const btn = $("set-save"); btn.disabled = true; $("set-error").textContent = "";
  const payload = {
    client_id: client.id,
    greeting: $("set-greeting").value.trim() || null,
    forward_number: $("set-forward").value.trim() || null,
    hours: { text: $("set-hours").value.trim() || null },
    after_hours: $("set-after").value.trim() || null,
    textback_message: $("set-textback").value.trim() || null,
  };
  const { error } = await sb.from("gw_settings").upsert(payload, { onConflict: "client_id" });
  btn.disabled = false;
  if (error) { $("set-error").textContent = error.message || "Couldn't save."; return; }
  toast("Setup saved.", "ok");
});

async function loadReports() {
  const { data } = await sb.from("gw_reports").select("*").eq("client_id", client.id)
    .order("period", { ascending: false }).order("created_at", { ascending: false });
  const list = $("rep-list");
  if (!data || !data.length) { list.innerHTML = '<div class="empty">Your first monthly report will show here.</div>'; return; }
  list.innerHTML = data.map((r) => {
    const m = r.metrics || {};
    const cells = Object.keys(m).length
      ? '<div class="metrics">' + Object.entries(m).map(([k, v]) =>
          '<div class="m"><b>' + escapeHtml(String(v)) + "</b><span>" + escapeHtml(k) + "</span></div>").join("") + "</div>"
      : "";
    return '<div class="card" style="margin-bottom:12px"><div class="row"><h3 style="flex:1;font-size:1.1rem">' +
      escapeHtml(r.title || r.period || "Report") + '</h3><span class="subtle">' + escapeHtml(r.period || "") + "</span></div>" +
      (r.summary ? '<p class="subtle" style="margin-top:6px">' + escapeHtml(r.summary) + "</p>" : "") + cells + "</div>";
  }).join("");
}

/* ---------- realtime ---------- */
function subscribe() {
  if (channel) return;
  const cid = "client_id=eq." + client.id;
  channel = sb.channel("gw-portal-" + client.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "gw_integrations", filter: cid }, loadIntegrations)
    .on("postgres_changes", { event: "*", schema: "public", table: "gw_messages", filter: cid }, loadMessages)
    .on("postgres_changes", { event: "*", schema: "public", table: "gw_reports", filter: cid }, loadReports)
    .on("postgres_changes", { event: "*", schema: "public", table: "gw_updates", filter: cid }, loadActivity)
    .on("postgres_changes", { event: "*", schema: "public", table: "gw_files", filter: cid }, loadFiles)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "gw_clients", filter: "id=eq." + client.id },
      async () => { const { data } = await sb.from("gw_clients").select("*").eq("id", client.id).single(); if (data) { client = data; renderPlan(); } })
    .subscribe();
}
function teardown() { if (channel) { sb.removeChannel(channel); channel = null; } }
