/* ============================================================
 * Groundwork — admin console
 * Owner-only. Manage clients, their integrations, messages, reports, and
 * reception/voicemail setup; triage assistant leads.
 * ============================================================ */
import {
  sb, CONFIGURED, REDIRECT, CARE_LABEL, STATUS_LABEL, INT_STATUS, MSG_KIND,
  fmtDate, fmtDateTime, escapeHtml, toast, showView,
} from "../portal/client.js";

const $ = (id) => document.getElementById(id);
let user = null;
let profiles = {};     // id -> {email, full_name}
let current = null;    // open client row

/* ---------- boot ---------- */
if (!CONFIGURED) {
  showView("view-auth");
  $("auth-error").textContent = "Backend not connected.";
  $("magic-form").querySelectorAll("input,button").forEach((el) => (el.disabled = true));
} else {
  sb.auth.getSession().then(({ data }) => routeSession(data.session));
  sb.auth.onAuthStateChange((_e, s) => { setTimeout(() => routeSession(s), 0); });
}

async function routeSession(session) {
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

$("magic-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim(); if (!email) return;
  const btn = $("magic-btn"); btn.disabled = true; $("auth-error").textContent = "";
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: REDIRECT } });
  btn.disabled = false;
  if (error) { $("auth-error").textContent = error.message; return; }
  $("sent-to").textContent = email; showView("view-sent");
});
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

/* ---------- clients list ---------- */
async function loadClients() {
  const { data, error } = await sb.from("gw_clients").select("*").order("created_at", { ascending: false });
  const list = $("client-list");
  if (error) { list.innerHTML = '<div class="empty">Couldn\'t load clients.</div>'; return; }
  if (!data.length) { list.innerHTML = '<div class="empty"><p>No clients yet. Click <b>New client</b> to add one.</p></div>'; return; }
  list.innerHTML = '<div class="cards">' + data.map((c) =>
    '<div class="card click" data-id="' + c.id + '"><div class="row"><h3 style="flex:1">' + escapeHtml(c.business_name) + "</h3>" +
    '<span class="badge ' + (c.status === "active" ? "live" : c.status === "paused" ? "paused" : "planned") + '">' + (STATUS_LABEL[c.status] || c.status) + "</span></div>" +
    '<div class="meta">' + escapeHtml(ownerEmail(c.owner_id)) + " · " + (CARE_LABEL[c.care_plan] || CARE_LABEL.none) + "</div></div>"
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
    '<div class="card inq" style="border-left:3px solid var(--accent)"><div class="row"><h3 style="flex:1">' + escapeHtml(q.name || q.business_name || "Website lead") + "</h3>" +
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
  if (!owner) { $("new-error").textContent = "No account for that email yet. Ask them to sign in at the portal once, then retry."; return; }
  const btn = $("new-save"); btn.disabled = true;
  const { error } = await sb.from("gw_clients").insert({ owner_id: owner.id, business_name: biz, contact_email: email, care_plan: $("n-plan").value, status: "onboarding" });
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
  $("cd-owner").textContent = ownerEmail(c.owner_id);
  $("cd-biz").value = c.business_name || ""; $("cd-email").value = c.contact_email || "";
  $("cd-plan").value = c.care_plan || "none"; $("cd-status").value = c.status || "onboarding";
  $("cd-phone").value = c.phone || ""; $("cd-error").textContent = "";
  await Promise.all([loadInts(), loadMsgs(), loadReps(), loadSet()]);
}

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
  const box = $("cd-ints");
  if (!data || !data.length) { box.innerHTML = '<div class="inline-note">No integrations yet.</div>'; return; }
  box.innerHTML = data.map((i) =>
    '<div class="row-line" style="padding:6px 0;border-bottom:1px solid var(--border)"><b style="flex:1;min-width:140px">' + escapeHtml(i.label) + "</b>" +
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
    '<button class="btn btn-danger btn-sm" data-dr="' + r.id + '">✕</button></div>'
  ).join("");
  box.querySelectorAll("[data-dr]").forEach((b) => b.addEventListener("click", async () => { await sb.from("gw_reports").delete().eq("id", b.dataset.dr); loadReps(); }));
}
$("rep-add").addEventListener("click", async () => {
  const metrics = {};
  const map = { "rep-calls": "calls", "rep-missed": "missed→saved", "rep-leads": "leads", "rep-reviews": "reviews" };
  for (const [id, key] of Object.entries(map)) { const v = $(id).value.trim(); if (v !== "") metrics[key] = Number(v); }
  const { error } = await sb.from("gw_reports").insert({ client_id: current.id, period: $("rep-period").value.trim() || null, title: $("rep-title").value.trim() || null, summary: $("rep-summary").value.trim() || null, metrics });
  if (error) { toast(error.message, "err"); return; }
  ["rep-period", "rep-title", "rep-summary", "rep-calls", "rep-missed", "rep-leads", "rep-reviews"].forEach((k) => ($(k).value = ""));
  toast("Report added.", "ok"); loadReps();
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
