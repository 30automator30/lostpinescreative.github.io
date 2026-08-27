/* ============================================================
 * Groundwork — admin console
 * Owner-only. Manage clients, their integrations, messages, reports, and
 * reception/voicemail setup; triage assistant leads.
 * ============================================================ */
import {
  sb, CONFIGURED, REDIRECT, CARE_LABEL, STATUS_LABEL, INT_STATUS, MSG_KIND,
  fmtDate, fmtDateTime, escapeHtml, toast, showView,
  loadClientFiles, uploadClientFiles, deleteAttachment, renderAttachments, wireUploader,
  loadClientUpdates,
} from "../portal/client.js";
import { initAuth, isRecovering } from "/portal-auth.js";

const $ = (id) => document.getElementById(id);
let user = null;
let profiles = {};     // id -> {email, full_name}
let current = null;    // open client row
let currentInts = [];  // integrations for the open client (for reorder)
let editingReportId = null;
let editingUpdateId = null;

/* ---------- boot ---------- */
if (!CONFIGURED) {
  showView("view-auth");
  $("auth-error").textContent = "Backend not connected.";
  $("auth-form").querySelectorAll("input,button").forEach((el) => (el.disabled = true));
} else {
  initAuth(sb, REDIRECT);
  sb.auth.getSession().then(({ data }) => routeSession(data.session));
  sb.auth.onAuthStateChange((_e, s) => { setTimeout(() => routeSession(s), 0); });
}

async function routeSession(session) {
  if (isRecovering()) return;
  if (!session || !session.user) {
    user = null; $("signout").style.display = "none"; $("who").textContent = ""; showView("view-auth"); return;
  }
  if (user && user.id === session.user.id) return;
  user = session.user;
  $("who").textContent = user.email;
  const { data: me } = await sb.from("dd_profiles").select("is_admin").eq("id", user.id).single();
  $("signout").style.display = "";
  if (!me || !me.is_admin) { showView("view-denied"); return; }
  enterConsole();
}

/* auth (email + password) wired in /portal-auth.js */
$("signout").addEventListener("click", () => sb.auth.signOut());
$("denied-out").addEventListener("click", () => sb.auth.signOut());

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === t));
  $("pane-clients").style.display = t.dataset.tab === "clients" ? "" : "none";
  $("pane-inbox").style.display = t.dataset.tab === "inbox" ? "" : "none";
}));

async function enterConsole() {
  showView("view-console");
  await loadProfiles();
  await Promise.all([loadClients(), loadInbox()]);
}

async function loadProfiles() {
  const { data } = await sb.from("dd_profiles").select("id,email,full_name");
  profiles = {}; (data || []).forEach((p) => (profiles[p.id] = p));
}
const ownerEmail = (id) => (profiles[id] ? profiles[id].email : "unknown");
const clientEmail = (c) => c.owner_email || (c.owner_id ? ownerEmail(c.owner_id) : "—");

/* ---------- clients list ---------- */
async function loadClients() {
  const { data, error } = await sb.from("gw_clients").select("*").order("created_at", { ascending: false });
  const list = $("client-list");
  if (error) { list.innerHTML = '<div class="empty">Couldn\'t load clients.</div>'; return; }
  if (!data.length) { list.innerHTML = '<div class="empty"><p>No clients yet. Click <b>New client</b> to add one.</p></div>'; return; }
  list.innerHTML = '<div class="cards">' + data.map((c) =>
    '<div class="card click" data-id="' + c.id + '"><div class="row"><h3 style="flex:1">' + escapeHtml(c.business_name) + "</h3>" +
    '<span class="badge ' + (c.status === "active" ? "live" : c.status === "paused" ? "paused" : "planned") + '">' + (STATUS_LABEL[c.status] || c.status) + "</span></div>" +
    '<div class="meta">' + escapeHtml(clientEmail(c)) + " · " + (CARE_LABEL[c.care_plan] || CARE_LABEL.none) + "</div></div>"
  ).join("") + "</div>";
  list.querySelectorAll("[data-id]").forEach((el) => el.addEventListener("click", () => openClient(el.dataset.id)));
}

/* ---------- inbox (assistant leads) ---------- */
async function loadInbox() {
  const { data } = await sb.from("gw_inquiries").select("*").eq("status", "new").order("created_at", { ascending: false });
  const badge = $("inbox-count"); badge.style.display = (data && data.length) ? "" : "none"; badge.textContent = (data || []).length;
  const list = $("inbox-list");
  if (!data || !data.length) { list.innerHTML = '<div class="empty">Inbox zero.</div>'; return; }
  list.innerHTML = data.map((q) =>
    '<div class="card inq"><div class="row"><h3 style="flex:1">' + escapeHtml(q.name || q.business_name || "Website lead") + "</h3>" +
    '<span class="badge new">' + escapeHtml(q.kind || "lead") + "</span></div>" +
    '<div class="meta">' + escapeHtml(q.email || "") + (q.phone ? " · " + escapeHtml(q.phone) : "") + (q.business_name ? " · " + escapeHtml(q.business_name) : "") + " · " + fmtDate(q.created_at) + "</div>" +
    '<p class="subtle">' + escapeHtml(q.message || "") + "</p>" +
    '<div class="row" style="margin-top:10px"><a class="btn btn-ghost btn-sm" href="mailto:' + escapeHtml(q.email || "") + '">Reply</a>' +
    '<button class="btn btn-ghost btn-sm" data-handled="' + q.id + '">Mark handled</button></div></div>'
  ).join("");
  list.querySelectorAll("[data-handled]").forEach((b) => b.addEventListener("click", async () => {
    await sb.from("gw_inquiries").update({ status: "handled" }).eq("id", b.dataset.handled);
    toast("Marked handled.", "ok"); loadInbox();
  }));
}

/* ---------- new client ---------- */
$("new-client").addEventListener("click", () => {
  ["n-email", "n-biz"].forEach((k) => ($(k).value = "")); $("n-plan").value = "none"; $("new-error").textContent = "";
  $("new-modal").classList.add("show");
});
$("new-cancel").addEventListener("click", () => $("new-modal").classList.remove("show"));
$("new-modal").addEventListener("click", (e) => { if (e.target === $("new-modal")) $("new-modal").classList.remove("show"); });
$("new-save").addEventListener("click", async () => {
  const email = $("n-email").value.trim().toLowerCase(), biz = $("n-biz").value.trim();
  if (!email || !biz) { $("new-error").textContent = "Owner email and business name are required."; return; }
  let owner = Object.values(profiles).find((p) => (p.email || "").toLowerCase() === email);
  if (!owner) { await loadProfiles(); owner = Object.values(profiles).find((p) => (p.email || "").toLowerCase() === email); }
  const btn = $("new-save"); btn.disabled = true;
  // owner_id links now if they have an account, otherwise on their first sign-in
  // (owner_email match handles access until then).
  const { error } = await sb.from("gw_clients").insert({ owner_id: owner ? owner.id : null, owner_email: email, business_name: biz, contact_email: email, care_plan: $("n-plan").value, status: "onboarding" });
  btn.disabled = false;
  if (error) { $("new-error").textContent = error.message; return; }
  $("new-modal").classList.remove("show"); toast("Client created.", "ok"); loadClients();
});

/* ---------- client detail ---------- */
$("back-list").addEventListener("click", () => { current = null; showView("view-console"); loadClients(); });

async function openClient(id) {
  const { data: c, error } = await sb.from("gw_clients").select("*").eq("id", id).single();
  if (error || !c) { toast("Couldn't open client.", "err"); return; }
  current = c;
  showView("view-client");
  $("cd-title").textContent = c.business_name;
  $("cd-owner").textContent = clientEmail(c) + (c.owner_id ? "" : " · pending first sign-in");
  $("cd-biz").value = c.business_name || ""; $("cd-email").value = c.contact_email || "";
  $("cd-plan").value = c.care_plan || "none"; $("cd-status").value = c.status || "onboarding";
  $("cd-phone").value = c.phone || ""; $("cd-error").textContent = "";
  // Billing state is mirrored from the onboarding intake by the Stripe webhook.
  const bill = $("cd-billing");
  if (bill) {
    bill.textContent = c.pay_status
      ? "Billing: " + c.pay_status + (c.stripe_subscription_id ? " · care subscription active" : "") + (c.intake_id ? " · linked to onboarding brief" : "")
      : (c.intake_id ? "Billing: awaiting first payment (linked to onboarding brief)" : "Billing: not linked to an onboarding brief");
  }
  editingReportId = null; editingUpdateId = null;
  $("rep-cancel").style.display = "none"; $("rep-add").textContent = "Add report";
  await Promise.all([loadInts(), loadMsgs(), loadReps(), loadSet(), loadUpdates(), loadFiles()]);
}

/* ---------- activity timeline (studio posts; edit/delete) ---------- */
async function loadUpdates() {
  const list = await loadClientUpdates(current.id);
  const box = $("cd-updates");
  if (!list.length) { box.innerHTML = '<li class="inline-note" style="border:none">No updates yet.</li>'; return; }
  box.innerHTML = list.map((u) => {
    const internal = !u.client_visible;
    if (u.id === editingUpdateId) {
      return '<li class="' + (internal ? "u-internal" : "") + '"><div class="u-when">' + fmtDateTime(u.created_at) + "</div>" +
        '<input class="up-edit" id="up-edit-body" value="' + escapeHtml(u.body) + '" style="margin-top:4px">' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:.78rem;color:var(--text-muted);margin:6px 0"><input type="checkbox" id="up-edit-internal"' + (internal ? " checked" : "") + ' style="width:auto"> Internal</label>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-ghost btn-sm" data-uc>Cancel</button><button class="btn btn-primary btn-sm" data-us="' + u.id + '">Save</button></div></li>';
    }
    return '<li class="' + (internal ? "u-internal" : "") + '"><div class="u-when">' + fmtDateTime(u.created_at) +
      (internal ? '<span class="u-tag">internal</span>' : "") +
      '<span class="u-acts"><button data-ue="' + u.id + '">Edit</button><button data-ud="' + u.id + '">Delete</button></span>' +
      '</div><div class="u-body">' + escapeHtml(u.body) + "</div></li>";
  }).join("");
  box.querySelectorAll("[data-ue]").forEach((b) => b.addEventListener("click", () => { editingUpdateId = b.dataset.ue; loadUpdates(); }));
  box.querySelectorAll("[data-uc]").forEach((b) => b.addEventListener("click", () => { editingUpdateId = null; loadUpdates(); }));
  box.querySelectorAll("[data-us]").forEach((b) => b.addEventListener("click", () => saveUpdate(b.dataset.us)));
  box.querySelectorAll("[data-ud]").forEach((b) => b.addEventListener("click", () => deleteUpdate(b.dataset.ud)));
}
$("upd-add").addEventListener("click", async () => {
  if (!current) return;
  const body = $("upd-body").value.trim(); if (!body) return;
  const btn = $("upd-add"); btn.disabled = true;
  const { error } = await sb.from("gw_updates").insert({
    client_id: current.id, author_id: user.id, body, client_visible: !$("upd-internal").checked,
  });
  btn.disabled = false;
  if (error) { toast(error.message, "err"); return; }
  $("upd-body").value = ""; $("upd-internal").checked = false;
  toast("Update posted.", "ok"); loadUpdates();
});
async function saveUpdate(id) {
  const body = $("up-edit-body").value.trim();
  if (!body) { toast("Update can't be empty.", "err"); return; }
  const internal = $("up-edit-internal").checked;
  editingUpdateId = null;
  const { error } = await sb.from("gw_updates").update({ body, client_visible: !internal }).eq("id", id);
  if (error) toast(error.message, "err"); else toast("Update saved.", "ok");
  loadUpdates();
}
async function deleteUpdate(id) {
  if (!confirm("Delete this update?")) return;
  const { error } = await sb.from("gw_updates").delete().eq("id", id);
  if (error) { toast(error.message, "err"); return; }
  toast("Update deleted.", "ok"); loadUpdates();
}

/* ---------- files ---------- */
async function loadFiles() {
  const files = await loadClientFiles(current.id);
  renderAttachments($("cd-files"), files, {
    canDelete: () => true, showInternal: true,
    onDelete: async (fid) => {
      const f = files.find((x) => x.id === fid);
      if (!f || !confirm("Remove " + (f.filename || "this file") + "?")) return;
      const { ok } = await deleteAttachment(f);
      if (!ok) { toast("Couldn't remove that file.", "err"); return; }
      toast("File removed.", "ok"); loadFiles();
    },
  });
}
wireUploader(document.getElementById("cd-uploader"), document.getElementById("cd-file-input"), async (files) => {
  if (!current) return;
  const zone = $("cd-uploader");
  const clientVisible = !$("cd-file-internal").checked;
  zone.style.pointerEvents = "none"; zone.style.opacity = ".6";
  const n = await uploadClientFiles(current.id, files, { clientVisible });
  zone.style.pointerEvents = ""; zone.style.opacity = "";
  if (n) toast(n === 1 ? "File added." : n + " files added.", "ok");
  loadFiles();
});

$("cd-save").addEventListener("click", async () => {
  const btn = $("cd-save"); btn.disabled = true; $("cd-error").textContent = "";
  const patch = { business_name: $("cd-biz").value.trim(), contact_email: $("cd-email").value.trim() || null,
    care_plan: $("cd-plan").value, status: $("cd-status").value, phone: $("cd-phone").value.trim() || null };
  const { error } = await sb.from("gw_clients").update(patch).eq("id", current.id);
  btn.disabled = false;
  if (error) { $("cd-error").textContent = error.message; return; }
  toast("Saved.", "ok"); $("cd-title").textContent = patch.business_name; loadClients();
});

$("client-delete").addEventListener("click", async () => {
  if (!current) return;
  if (!confirm("Delete this client and all its data? This can't be undone.")) return;
  const { error } = await sb.from("gw_clients").delete().eq("id", current.id);
  if (error) { toast(error.message, "err"); return; }
  toast("Client deleted.", "ok"); current = null; showView("view-console"); loadClients();
});

/* integrations */
async function loadInts() {
  const { data } = await sb.from("gw_integrations").select("*").eq("client_id", current.id).order("sort").order("label");
  currentInts = data || [];
  const box = $("cd-ints");
  if (!currentInts.length) { box.innerHTML = '<div class="inline-note">No integrations yet.</div>'; return; }
  const last = currentInts.length - 1;
  box.innerHTML = currentInts.map((i, idx) =>
    '<div class="row-line" style="padding:6px 0;border-bottom:1px solid var(--border)"><b style="flex:1;min-width:120px">' + escapeHtml(i.label) + "</b>" +
    '<button class="int-move" data-iu="' + i.id + '"' + (idx === 0 ? " disabled" : "") + ' title="Move up">▲</button>' +
    '<button class="int-move" data-idn="' + i.id + '"' + (idx === last ? " disabled" : "") + ' title="Move down">▼</button>' +
    '<select data-st="' + i.id + '">' + ["planned","in_progress","live","paused"].map((s) => '<option value="' + s + '"' + (s === i.status ? " selected" : "") + ">" + INT_STATUS[s] + "</option>").join("") + "</select>" +
    (i.url ? '<a href="' + escapeHtml(i.url) + '" target="_blank" rel="noopener">open</a>' : "") +
    '<button class="btn btn-danger btn-sm" data-del-int="' + i.id + '">✕</button></div>'
  ).join("");
  box.querySelectorAll("[data-st]").forEach((sel) => sel.addEventListener("change", async () => {
    await sb.from("gw_integrations").update({ status: sel.value }).eq("id", sel.dataset.st); toast("Updated.", "ok");
  }));
  box.querySelectorAll("[data-del-int]").forEach((b) => b.addEventListener("click", async () => {
    await sb.from("gw_integrations").delete().eq("id", b.dataset.delInt); loadInts();
  }));
  box.querySelectorAll("[data-iu]").forEach((b) => b.addEventListener("click", () => moveInt(b.dataset.iu, -1)));
  box.querySelectorAll("[data-idn]").forEach((b) => b.addEventListener("click", () => moveInt(b.dataset.idn, 1)));
}

async function moveInt(id, delta) {
  const i = currentInts.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= currentInts.length) return;
  const arr = currentInts.slice();
  [arr[i], arr[j]] = [arr[j], arr[i]];
  currentInts = arr;
  const results = await Promise.all(arr.map((x, idx) =>
    x.sort === idx ? Promise.resolve({}) : sb.from("gw_integrations").update({ sort: idx }).eq("id", x.id)));
  if (results.some((r) => r && r.error)) toast("Couldn't reorder.", "err");
  loadInts();
}
$("int-add").addEventListener("click", async () => {
  const label = $("int-label").value.trim(); if (!label) return;
  const { error } = await sb.from("gw_integrations").insert({ client_id: current.id, label, status: $("int-status").value, url: $("int-url").value.trim() || null });
  if (error) { toast(error.message, "err"); return; }
  $("int-label").value = ""; $("int-url").value = ""; loadInts();
});

/* messages */
async function loadMsgs() {
  const { data } = await sb.from("gw_messages").select("*").eq("client_id", current.id).order("created_at", { ascending: false });
  const box = $("cd-msgs");
  if (!data || !data.length) { box.innerHTML = '<div class="inline-note">No messages.</div>'; return; }
  box.innerHTML = data.map((m) =>
    '<div class="msg-item ' + (m.status !== "new" ? "handled" : "") + '"><div class="msg-top"><span class="badge ' + (m.status === "new" ? "new" : "handled") + '">' + (MSG_KIND[m.kind] || m.kind) + "</span><b>" + escapeHtml(m.from_name || m.from_phone || "—") + "</b>" +
    '<span class="spacer" style="flex:1"></span><span class="msg-when">' + fmtDateTime(m.created_at) + "</span></div>" +
    (m.body ? '<div class="msg-body">' + escapeHtml(m.body) + "</div>" : "") +
    '<div class="row" style="margin-top:8px;gap:6px">' +
    (m.status === "new" ? '<button class="btn btn-ghost btn-sm" data-mh="' + m.id + '">Mark handled</button>' : "") +
    '<button class="btn btn-danger btn-sm" data-md="' + m.id + '">Delete</button></div></div>'
  ).join("");
  box.querySelectorAll("[data-mh]").forEach((b) => b.addEventListener("click", async () => { await sb.from("gw_messages").update({ status: "handled" }).eq("id", b.dataset.mh); loadMsgs(); }));
  box.querySelectorAll("[data-md]").forEach((b) => b.addEventListener("click", async () => { await sb.from("gw_messages").delete().eq("id", b.dataset.md); loadMsgs(); }));
}
$("msg-add").addEventListener("click", async () => {
  const body = $("msg-body").value.trim();
  const { error } = await sb.from("gw_messages").insert({ client_id: current.id, kind: $("msg-kind").value, from_name: $("msg-from").value.trim() || null, from_phone: $("msg-phone").value.trim() || null, body: body || null });
  if (error) { toast(error.message, "err"); return; }
  ["msg-from", "msg-phone", "msg-body"].forEach((k) => ($(k).value = "")); loadMsgs();
});

/* reports */
async function loadReps() {
  const { data } = await sb.from("gw_reports").select("*").eq("client_id", current.id).order("period", { ascending: false });
  const box = $("cd-reps");
  if (!data || !data.length) { box.innerHTML = '<div class="inline-note">No reports.</div>'; return; }
  box.innerHTML = data.map((r) =>
    '<div class="row-line" style="padding:6px 0;border-bottom:1px solid var(--border)"><b style="flex:1">' + escapeHtml(r.title || r.period || "Report") + '</b><span class="subtle">' + escapeHtml(r.period || "") + "</span>" +
    '<button class="btn btn-ghost btn-sm" data-er="' + r.id + '">Edit</button>' +
    '<button class="btn btn-danger btn-sm" data-dr="' + r.id + '">✕</button></div>'
  ).join("");
  box.querySelectorAll("[data-er]").forEach((b) => b.addEventListener("click", () => startEditReport(data.find((x) => x.id === b.dataset.er))));
  box.querySelectorAll("[data-dr]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this report?")) return;
    await sb.from("gw_reports").delete().eq("id", b.dataset.dr);
    if (editingReportId === b.dataset.dr) resetRepForm();
    loadReps();
  }));
}

function startEditReport(r) {
  if (!r) return;
  editingReportId = r.id;
  $("rep-period").value = r.period || ""; $("rep-title").value = r.title || ""; $("rep-summary").value = r.summary || "";
  const m = r.metrics || {};
  $("rep-calls").value = m["calls"] != null ? m["calls"] : "";
  $("rep-missed").value = m["missed→saved"] != null ? m["missed→saved"] : "";
  $("rep-leads").value = m["leads"] != null ? m["leads"] : "";
  $("rep-reviews").value = m["reviews"] != null ? m["reviews"] : "";
  $("rep-add").textContent = "Update report"; $("rep-cancel").style.display = "";
}
function resetRepForm() {
  editingReportId = null;
  ["rep-period", "rep-title", "rep-summary", "rep-calls", "rep-missed", "rep-leads", "rep-reviews"].forEach((k) => ($(k).value = ""));
  $("rep-add").textContent = "Add report"; $("rep-cancel").style.display = "none";
}
$("rep-cancel").addEventListener("click", resetRepForm);
$("rep-add").addEventListener("click", async () => {
  if (!current) return;
  const metrics = {};
  const map = { "rep-calls": "calls", "rep-missed": "missed→saved", "rep-leads": "leads", "rep-reviews": "reviews" };
  for (const [id, key] of Object.entries(map)) { const v = $(id).value.trim(); if (v !== "") metrics[key] = Number(v); }
  const payload = { period: $("rep-period").value.trim() || null, title: $("rep-title").value.trim() || null, summary: $("rep-summary").value.trim() || null, metrics };
  const { error } = editingReportId
    ? await sb.from("gw_reports").update(payload).eq("id", editingReportId)
    : await sb.from("gw_reports").insert({ client_id: current.id, ...payload });
  if (error) { toast(error.message, "err"); return; }
  toast(editingReportId ? "Report updated." : "Report added.", "ok");
  resetRepForm(); loadReps();
});

/* settings */
async function loadSet() {
  const { data } = await sb.from("gw_settings").select("*").eq("client_id", current.id).maybeSingle();
  $("cd-greeting").value = (data && data.greeting) || ""; $("cd-forward").value = (data && data.forward_number) || "";
  $("cd-hours").value = (data && data.hours && data.hours.text) || ""; $("cd-after").value = (data && data.after_hours) || "";
  $("cd-textback").value = (data && data.textback_message) || "";
}
$("cd-set-save").addEventListener("click", async () => {
  const btn = $("cd-set-save"); btn.disabled = true;
  const payload = { client_id: current.id, greeting: $("cd-greeting").value.trim() || null, forward_number: $("cd-forward").value.trim() || null,
    hours: { text: $("cd-hours").value.trim() || null }, after_hours: $("cd-after").value.trim() || null, textback_message: $("cd-textback").value.trim() || null };
  const { error } = await sb.from("gw_settings").upsert(payload, { onConflict: "client_id" });
  btn.disabled = false;
  if (error) { toast(error.message, "err"); return; }
  toast("Setup saved.", "ok");
});
