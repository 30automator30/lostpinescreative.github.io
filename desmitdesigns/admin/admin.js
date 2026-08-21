/* ============================================================
 * DeSmit Designs — admin console
 * Owner-only. Triage inbox, quote & update projects, live.
 * ============================================================ */
import {
  sb, CONFIGURED, REDIRECT, STATUS_LABEL, money, fmtDate, fmtDateTime,
  escapeHtml, toast, showView,
} from "../portal/client.js";

const $ = (id) => document.getElementById(id);

let user = null;
let profiles = {};      // id -> {email, full_name}
let channel = null;
let editingId = null;

/* ---------- boot ---------- */
if (!CONFIGURED) {
  showView("view-auth");
  $("auth-error").textContent = "Backend not connected yet — fill portal/config.js.";
  $("magic-form").querySelectorAll("input,button").forEach((el) => (el.disabled = true));
} else {
  sb.auth.getSession().then(({ data }) => routeSession(data.session));
  // Defer out of the callback: awaiting a Supabase call *inside* the
  // onAuthStateChange handler deadlocks on its internal auth lock. setTimeout
  // releases the lock first so routeSession's queries can run.
  sb.auth.onAuthStateChange((_e, s) => { setTimeout(() => routeSession(s), 0); });
}

async function routeSession(session) {
  if (!session || !session.user) {
    user = null;
    $("signout").style.display = "none";
    $("who").textContent = "";
    teardown();
    showView("view-auth");
    return;
  }
  if (user && user.id === session.user.id) return;
  user = session.user;
  $("who").textContent = user.email;
  // gate on admin
  const { data: me } = await sb.from("dd_profiles").select("is_admin").eq("id", user.id).single();
  if (!me || !me.is_admin) { showView("view-denied"); $("signout").style.display = ""; return; }
  $("signout").style.display = "";
  enterConsole();
}

/* ---------- auth ---------- */
$("magic-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  if (!email) return;
  const btn = $("magic-btn"); btn.disabled = true; $("auth-error").textContent = "";
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: REDIRECT } });
  btn.disabled = false;
  if (error) { $("auth-error").textContent = error.message; return; }
  $("sent-to").textContent = email; showView("view-sent");
});
$("signout").addEventListener("click", () => sb.auth.signOut());
$("denied-out").addEventListener("click", () => sb.auth.signOut());

/* ---------- console ---------- */
async function enterConsole() {
  showView("view-console");
  await loadProfiles();
  await Promise.all([loadInbox(), loadProjects()]);
  subscribe();
}

async function loadProfiles() {
  const { data } = await sb.from("dd_profiles").select("id,email,full_name");
  profiles = {};
  (data || []).forEach((p) => (profiles[p.id] = p));
}
const custLabel = (id) => {
  const p = profiles[id];
  return p ? (p.full_name ? p.full_name + " · " + p.email : p.email) : "Customer";
};

/* tab switching */
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === t));
    const tab = t.dataset.tab;
    $("pane-inbox").style.display = tab === "inbox" ? "" : "none";
    $("pane-projects").style.display = tab === "projects" ? "" : "none";
  }));

/* ---------- inbox: new leads + projects awaiting a quote ---------- */
async function loadInbox() {
  const list = $("inbox-list");
  const [{ data: inq }, { data: reqs }] = await Promise.all([
    sb.from("dd_inquiries").select("*").eq("status", "new").order("created_at", { ascending: false }),
    sb.from("dd_projects").select("*").eq("status", "requested").order("created_at", { ascending: false }),
  ]);
  const total = (inq ? inq.length : 0) + (reqs ? reqs.length : 0);
  const badge = $("inbox-count");
  badge.style.display = total ? "" : "none";
  badge.textContent = total;

  let html = "";
  (reqs || []).forEach((p) => {
    html +=
      '<div class="card click" data-proj="' + p.id + '">' +
      '<div class="row"><h3 style="flex:1">' + escapeHtml(p.title) + "</h3>" +
      '<span class="badge requested">Needs quote</span></div>' +
      '<div class="meta">' + escapeHtml(custLabel(p.customer_id)) + " · " + fmtDate(p.created_at) + "</div>" +
      '<p class="subtle">' + escapeHtml(p.description || "") + "</p></div>";
  });
  (inq || []).forEach((q) => {
    html +=
      '<div class="card inq">' +
      '<div class="row"><h3 style="flex:1">' + escapeHtml(q.name || "Website lead") + "</h3>" +
      '<span class="badge in_progress">' + escapeHtml(q.kind || "lead") + "</span></div>" +
      '<div class="meta">' + escapeHtml(q.email || "") +
      (q.service_type ? " · " + escapeHtml(q.service_type) : "") + " · " + fmtDate(q.created_at) + "</div>" +
      '<p class="subtle">' + escapeHtml(q.message || "") + "</p>" +
      '<div class="row" style="margin-top:10px">' +
      '<a class="btn btn-ghost btn-sm" href="mailto:' + escapeHtml(q.email || "") + '">Reply</a>' +
      '<button class="btn btn-ghost btn-sm" data-handled="' + q.id + '">Mark handled</button></div></div>';
  });
  list.innerHTML = html ||
    '<div class="empty"><p>Inbox zero. New service requests and assistant leads land here.</p></div>';

  list.querySelectorAll("[data-proj]").forEach((el) =>
    el.addEventListener("click", () => openEditor(el.dataset.proj)));
  list.querySelectorAll("[data-handled]").forEach((el) =>
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      await sb.from("dd_inquiries").update({ status: "handled" }).eq("id", el.dataset.handled);
      toast("Marked handled.", "ok"); loadInbox();
    }));
}

/* ---------- all projects ---------- */
$("filter-status").addEventListener("change", loadProjects);
async function loadProjects() {
  const list = $("proj-list");
  const status = $("filter-status").value;
  let q = sb.from("dd_projects").select("*").order("updated_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) { list.innerHTML = '<div class="empty">Couldn\'t load projects.</div>'; return; }
  if (!data.length) { list.innerHTML = '<div class="empty"><p>No projects.</p></div>'; return; }
  list.innerHTML = '<div class="cards">' + data.map((p) =>
    '<div class="card click" data-proj="' + p.id + '">' +
    '<div class="row"><h3 style="flex:1">' + escapeHtml(p.title) + "</h3>" +
    '<span class="badge ' + p.status + '">' + STATUS_LABEL[p.status] + "</span></div>" +
    '<div class="meta">' + escapeHtml(custLabel(p.customer_id)) + " · updated " + fmtDate(p.updated_at) + "</div>" +
    '<div class="row"><div class="bar"><span style="width:' + (p.progress_percent || 0) + '%"></span></div>' +
    '<span class="pct">' + (p.progress_percent || 0) + "%</span>" +
    (p.quote_amount != null ? '<b style="color:var(--accent-light)">' + money(p.quote_amount) + "</b>" : "") +
    "</div></div>").join("") + "</div>";
  list.querySelectorAll("[data-proj]").forEach((el) =>
    el.addEventListener("click", () => openEditor(el.dataset.proj)));
}

/* ---------- editor ---------- */
async function openEditor(id) {
  editingId = id;
  const { data: p, error } = await sb.from("dd_projects").select("*").eq("id", id).single();
  if (error || !p) { toast("Couldn't open project.", "err"); return; }
  $("edit-title").textContent = p.title;
  $("e-customer").value = custLabel(p.customer_id);
  $("e-name").value = p.title;
  $("e-status").value = p.status;
  $("e-progress").value = p.progress_percent || 0;
  $("e-quote").value = p.quote_amount != null ? p.quote_amount : "";
  $("e-service").value = p.service_type || "";
  $("e-quotenotes").value = p.quote_notes || "";
  $("e-desc").value = p.description || "";
  $("e-update").value = ""; $("e-update-pct").value = ""; $("e-update-internal").checked = false;
  $("edit-share-email").value = "";
  $("edit-error").textContent = "";
  await loadEditorTimeline(id);
  await loadEditorShares(id);
  $("edit-modal").classList.add("show");
}

async function loadEditorShares(id) {
  const box = $("edit-shares");
  const { data } = await sb.from("dd_project_shares").select("email,user_id")
    .eq("project_id", id).order("created_at", { ascending: true });
  if (!data || !data.length) { box.innerHTML = '<div class="inline-note">Not shared with anyone yet.</div>'; return; }
  box.innerHTML = data.map((s) =>
    '<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">' +
    '<span>' + escapeHtml(s.email) +
    (s.user_id ? ' <span class="badge complete" style="font-size:.6rem">active</span>'
               : ' <span class="badge quoted" style="font-size:.6rem">invited</span>') + "</span>" +
    '<button class="btn btn-danger btn-sm" data-unshare="' + encodeURIComponent(s.email) + '">Remove</button></div>').join("");
  box.querySelectorAll("[data-unshare]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      await sb.rpc("dd_unshare_project", { p_project: id, p_email: decodeURIComponent(b.dataset.unshare) });
      loadEditorShares(id);
    }));
}

$("edit-share-add").addEventListener("click", async () => {
  if (!editingId) return;
  const email = $("edit-share-email").value.trim();
  if (!email) return;
  const btn = $("edit-share-add"); btn.disabled = true;
  const { error } = await sb.rpc("dd_share_project", { p_project: editingId, p_email: email });
  btn.disabled = false;
  if (error) { $("edit-error").textContent = error.message; return; }
  $("edit-share-email").value = "";
  toast("Shared with " + email, "ok");
  loadEditorShares(editingId);
});

async function loadEditorTimeline(id) {
  const { data: ups } = await sb.from("dd_project_updates").select("*")
    .eq("project_id", id).order("created_at", { ascending: false });
  const tl = $("edit-timeline");
  if (!ups || !ups.length) { tl.innerHTML = '<li><div class="t-body subtle">No updates yet.</div></li>'; return; }
  tl.innerHTML = ups.map((u) => {
    const internal = !u.customer_visible;
    const mine = u.author_id === user.id;
    return '<li class="' + (internal ? "t-internal" : "") + '"><div class="t-when">' +
      fmtDateTime(u.created_at) + (mine ? " · you" : " · customer") +
      (u.percent != null ? " · " + u.percent + "%" : "") +
      (internal ? '<span class="t-tag">internal</span>' : "") + "</div>" +
      '<div class="t-body">' + escapeHtml(u.body) + "</div></li>";
  }).join("");
}

$("edit-cancel").addEventListener("click", () => $("edit-modal").classList.remove("show"));
$("edit-modal").addEventListener("click", (e) => {
  if (e.target === $("edit-modal")) $("edit-modal").classList.remove("show");
});

$("edit-save").addEventListener("click", async () => {
  if (!editingId) return;
  const btn = $("edit-save"); btn.disabled = true; $("edit-error").textContent = "";
  const patch = {
    title: $("e-name").value.trim(),
    status: $("e-status").value,
    progress_percent: Math.max(0, Math.min(100, parseInt($("e-progress").value || "0", 10))),
    quote_amount: $("e-quote").value === "" ? null : Number($("e-quote").value),
    service_type: $("e-service").value.trim() || null,
    quote_notes: $("e-quotenotes").value.trim() || null,
    description: $("e-desc").value.trim() || null,
  };
  const { error } = await sb.from("dd_projects").update(patch).eq("id", editingId);
  btn.disabled = false;
  if (error) { $("edit-error").textContent = error.message; return; }
  toast("Saved.", "ok");
  $("edit-modal").classList.remove("show");
  loadInbox(); loadProjects();
});

$("edit-post").addEventListener("click", async () => {
  if (!editingId) return;
  const body = $("e-update").value.trim();
  if (!body) { $("edit-error").textContent = "Write an update first."; return; }
  const pctRaw = $("e-update-pct").value;
  const percent = pctRaw === "" ? null : Math.max(0, Math.min(100, parseInt(pctRaw, 10)));
  const customer_visible = !$("e-update-internal").checked;
  const btn = $("edit-post"); btn.disabled = true;
  const { error } = await sb.from("dd_project_updates").insert({
    project_id: editingId, body, percent, customer_visible,
  });
  // If a percent was given, also move the project's headline progress.
  if (!error && percent != null) {
    await sb.from("dd_projects").update({ progress_percent: percent }).eq("id", editingId);
    $("e-progress").value = percent;
  }
  btn.disabled = false;
  if (error) { $("edit-error").textContent = error.message; return; }
  $("e-update").value = ""; $("e-update-pct").value = ""; $("e-update-internal").checked = false;
  toast("Update posted.", "ok");
  loadEditorTimeline(editingId); loadProjects();
});

$("edit-delete").addEventListener("click", async () => {
  if (!editingId) return;
  if (!confirm("Delete this project and its updates? This can't be undone.")) return;
  const { error } = await sb.from("dd_projects").delete().eq("id", editingId);
  if (error) { $("edit-error").textContent = error.message; return; }
  toast("Project deleted.", "ok");
  $("edit-modal").classList.remove("show");
  loadInbox(); loadProjects();
});

/* ---------- new project ---------- */
$("admin-new").addEventListener("click", () => {
  ["n-email", "n-title", "n-service", "n-desc"].forEach((k) => ($(k).value = ""));
  $("new-error").textContent = "";
  $("new-modal").classList.add("show");
});
$("new-cancel").addEventListener("click", () => $("new-modal").classList.remove("show"));
$("new-modal").addEventListener("click", (e) => {
  if (e.target === $("new-modal")) $("new-modal").classList.remove("show");
});
$("new-save").addEventListener("click", async () => {
  const email = $("n-email").value.trim().toLowerCase();
  const title = $("n-title").value.trim();
  if (!email || !title) { $("new-error").textContent = "Email and title are required."; return; }
  // resolve email -> customer id (must have signed in before)
  let cust = Object.values(profiles).find((p) => (p.email || "").toLowerCase() === email);
  if (!cust) {
    await loadProfiles(); // refresh in case they just signed up
    cust = Object.values(profiles).find((p) => (p.email || "").toLowerCase() === email);
  }
  const btn = $("new-save"); btn.disabled = true;
  // If the client already has an account they own it; otherwise the admin owns
  // it and it's shared to the client's email so they see it on first sign-in.
  const ownerId = cust ? cust.id : user.id;
  const { data: proj, error } = await sb.from("dd_projects").insert({
    customer_id: ownerId,
    title,
    service_type: $("n-service").value.trim() || null,
    description: $("n-desc").value.trim() || null,
    status: "requested",
  }).select("id").single();
  if (error) { btn.disabled = false; $("new-error").textContent = error.message; return; }
  if (!cust) {
    const { error: e2 } = await sb.rpc("dd_share_project", { p_project: proj.id, p_email: email });
    if (e2) { btn.disabled = false; $("new-error").textContent = "Project made, but sharing failed: " + e2.message; return; }
  }
  btn.disabled = false;
  $("new-modal").classList.remove("show");
  toast("Project created.", "ok");
  loadProjects();
});

/* ---------- realtime ---------- */
function subscribe() {
  if (channel) return;
  const refresh = () => { loadInbox(); loadProjects(); if (editingId && $("edit-modal").classList.contains("show")) loadEditorTimeline(editingId); };
  channel = sb.channel("dd-admin")
    .on("postgres_changes", { event: "*", schema: "public", table: "dd_projects" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "dd_project_updates" }, () => { if (editingId && $("edit-modal").classList.contains("show")) loadEditorTimeline(editingId); })
    .on("postgres_changes", { event: "*", schema: "public", table: "dd_inquiries" }, loadInbox)
    .subscribe();
}
function teardown() { if (channel) { sb.removeChannel(channel); channel = null; } }
