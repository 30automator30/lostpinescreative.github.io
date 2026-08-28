/* ============================================================
 * DeSmit Designs — admin console
 * Owner-only. Triage inbox, quote & update projects, live.
 * ============================================================ */
import {
  sb, CONFIGURED, REDIRECT, STATUS_LABEL, money, fmtDate, fmtDateTime,
  escapeHtml, toast, showView, shareInvite,
  ATTACH_BUCKET, uploadProjectFiles, loadProjectFiles, deleteAttachment, renderAttachments, wireUploader,
  notifyClientUpdate, loadMilestones, CHECK_SVG, linkify,
} from "../portal/client.js";
import { initAuth, isRecovering } from "/portal-auth.js";

const $ = (id) => document.getElementById(id);

let user = null;
let profiles = {};      // id -> {email, full_name}
let channel = null;
let editingId = null;
let editFiles = [];       // dd_project_files rows for the open editor
let editMilestones = [];  // dd_milestones rows for the open editor
let editUpdates = [];     // dd_project_updates rows for the open editor
let editingUpdateId = null; // update currently being edited inline
let editingMsId = null;     // milestone currently being renamed inline

/* ---------- boot ---------- */
if (!CONFIGURED) {
  showView("view-auth");
  $("auth-error").textContent = "Backend not connected yet — fill portal/config.js.";
  $("auth-form").querySelectorAll("input,button").forEach((el) => (el.disabled = true));
} else {
  initAuth(sb, REDIRECT);
  sb.auth.getSession().then(({ data }) => routeSession(data.session));
  // Defer out of the callback: awaiting a Supabase call *inside* the
  // onAuthStateChange handler deadlocks on its internal auth lock. setTimeout
  // releases the lock first so routeSession's queries can run.
  sb.auth.onAuthStateChange((_e, s) => { setTimeout(() => routeSession(s), 0); });
}

async function routeSession(session) {
  if (isRecovering()) return;
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

/* ---------- auth (email + password wired in /portal-auth.js) ---------- */
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
  $("e-progress-auto").checked = !!p.progress_auto;
  $("e-progress").disabled = !!p.progress_auto;
  $("e-quote").value = p.quote_amount != null ? p.quote_amount : "";
  $("e-service").value = p.service_type || "";
  $("e-quotenotes").value = p.quote_notes || "";
  $("e-desc").value = p.description || "";
  $("e-update").value = ""; $("e-update-pct").value = ""; $("e-update-internal").checked = false;
  $("e-update-email").checked = false; $("e-update-email").disabled = false;
  editingUpdateId = null; editingMsId = null;
  $("edit-share-email").value = "";
  $("edit-error").textContent = "";
  $("e-files").innerHTML = ""; $("e-file-internal").checked = false;
  await loadEditorTimeline(id);
  await loadEditorShares(id);
  loadEditorFiles(id);
  loadEditorMilestones(id);
  $("edit-modal").classList.add("show");
}

/* ---------- milestones ---------- */
async function loadEditorMilestones(id) {
  if (id !== editingId) return;
  editMilestones = await loadMilestones(id);
  if (id !== editingId) return;
  renderEditorMilestones();
  syncAutoProgress();
}

function renderEditorMilestones() {
  const ul = $("e-milestones");
  if (!editMilestones.length) {
    ul.innerHTML = '<li class="ms-empty" style="border:none">No milestones yet — add the first below.</li>';
    return;
  }
  const last = editMilestones.length - 1;
  ul.innerHTML = editMilestones.map((m, i) => {
    const check = '<button class="ms-check' + (m.done ? " done" : "") + '" data-toggle="' + m.id +
      '" title="Toggle done">' + (m.done ? CHECK_SVG : "") + "</button>";
    if (m.id === editingMsId) {
      return '<li class="' + (m.done ? "done" : "") + '">' + check +
        '<input class="ms-edit-input" id="ms-edit-input" value="' + escapeHtml(m.title) + '">' +
        '<button class="btn btn-primary btn-sm" data-ms-save="' + m.id + '">Save</button></li>';
    }
    return '<li class="' + (m.done ? "done" : "") + '">' + check +
      '<span class="ms-title" data-rename="' + m.id + '" title="Click to rename">' + escapeHtml(m.title) + "</span>" +
      '<button class="ms-move" data-up="' + m.id + '"' + (i === 0 ? " disabled" : "") + ' title="Move up">▲</button>' +
      '<button class="ms-move" data-down="' + m.id + '"' + (i === last ? " disabled" : "") + ' title="Move down">▼</button>' +
      '<button class="ms-del" data-del-ms="' + m.id + '" title="Remove">&times;</button></li>';
  }).join("");
  ul.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => toggleMilestone(b.dataset.toggle)));
  ul.querySelectorAll("[data-del-ms]").forEach((b) => b.addEventListener("click", () => deleteMilestone(b.dataset.delMs)));
  ul.querySelectorAll("[data-rename]").forEach((s) => s.addEventListener("click", () => {
    editingMsId = s.dataset.rename; renderEditorMilestones();
    const inp = $("ms-edit-input"); if (inp) { inp.focus(); inp.select(); }
  }));
  ul.querySelectorAll("[data-ms-save]").forEach((b) => b.addEventListener("click", () => saveMilestoneTitle(b.dataset.msSave)));
  ul.querySelectorAll("[data-up]").forEach((b) => b.addEventListener("click", () => moveMilestone(b.dataset.up, -1)));
  ul.querySelectorAll("[data-down]").forEach((b) => b.addEventListener("click", () => moveMilestone(b.dataset.down, 1)));
  const inp = $("ms-edit-input");
  if (inp) inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveMilestoneTitle(editingMsId); }
    else if (e.key === "Escape") { editingMsId = null; renderEditorMilestones(); }
  });
}

async function saveMilestoneTitle(id) {
  const inp = $("ms-edit-input"); if (!inp) return;
  const title = inp.value.trim();
  if (!title) { toast("Title can't be empty.", "err"); return; }
  editingMsId = null;
  const { error } = await sb.from("dd_milestones").update({ title }).eq("id", id);
  if (error) toast(error.message, "err");
  loadEditorMilestones(editingId); loadProjects();
}

async function moveMilestone(id, delta) {
  const i = editMilestones.findIndex((m) => m.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= editMilestones.length) return;
  const arr = editMilestones.slice();
  [arr[i], arr[j]] = [arr[j], arr[i]];
  editMilestones = arr;             // optimistic reorder
  renderEditorMilestones();
  const results = await Promise.all(arr.map((m, idx) =>
    m.position === idx ? Promise.resolve({}) : sb.from("dd_milestones").update({ position: idx }).eq("id", m.id)));
  if (results.some((r) => r && r.error)) toast("Couldn't save the new order.", "err");
  loadEditorMilestones(editingId);
}

// When auto is on, reflect the milestone ratio in the (disabled) progress field.
function syncAutoProgress() {
  if (!$("e-progress-auto").checked) return;
  const t = editMilestones.length;
  const d = editMilestones.filter((m) => m.done).length;
  $("e-progress").value = t ? Math.round((d / t) * 100) : 0;
}

async function toggleMilestone(id) {
  const m = editMilestones.find((x) => x.id === id); if (!m) return;
  const { error } = await sb.from("dd_milestones").update({ done: !m.done }).eq("id", id);
  if (error) { toast(error.message, "err"); return; }
  loadEditorMilestones(editingId); loadProjects(); // trigger may have moved progress
}

async function deleteMilestone(id) {
  const { error } = await sb.from("dd_milestones").delete().eq("id", id);
  if (error) { toast(error.message, "err"); return; }
  loadEditorMilestones(editingId); loadProjects();
}

$("ms-add").addEventListener("click", async () => {
  if (!editingId) return;
  const title = $("ms-title").value.trim();
  if (!title) return;
  const btn = $("ms-add"); btn.disabled = true;
  const { error } = await sb.from("dd_milestones").insert({
    project_id: editingId, title, position: editMilestones.length,
  });
  btn.disabled = false;
  if (error) { toast(error.message, "err"); return; }
  $("ms-title").value = "";
  loadEditorMilestones(editingId); loadProjects();
});
$("ms-title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("ms-add").click(); } });

$("e-progress-auto").addEventListener("change", () => {
  $("e-progress").disabled = $("e-progress-auto").checked;
  syncAutoProgress();
});

async function loadEditorFiles(id) {
  if (id !== editingId) return;
  editFiles = await loadProjectFiles(id);
  if (id !== editingId) return;
  renderAttachments($("e-files"), editFiles, {
    canDelete: () => true,          // admin may remove any file
    showInternal: true,
    onDelete: async (fid) => {
      const f = editFiles.find((x) => x.id === fid);
      if (!f || !confirm("Remove " + (f.filename || "this file") + "?")) return;
      const { ok } = await deleteAttachment(f);
      if (!ok) { toast("Couldn't remove that file.", "err"); return; }
      toast("File removed.", "ok");
      loadEditorFiles(editingId);
    },
  });
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
  const { ok, error } = await shareInvite(editingId, email);
  btn.disabled = false;
  if (!ok) { $("edit-error").textContent = error || "Couldn't share."; return; }
  $("edit-share-email").value = "";
  toast("Invite emailed to " + email, "ok");
  loadEditorShares(editingId);
});

async function loadEditorTimeline(id) {
  const { data: ups } = await sb.from("dd_project_updates").select("*")
    .eq("project_id", id).order("created_at", { ascending: false });
  editUpdates = ups || [];
  renderEditorTimeline();
}

function renderEditorTimeline() {
  const tl = $("edit-timeline");
  if (!editUpdates.length) { tl.innerHTML = '<li><div class="t-body subtle">No updates yet.</div></li>'; return; }
  tl.innerHTML = editUpdates.map((u) => {
    const internal = !u.customer_visible;
    const mine = u.author_id === user.id;
    if (u.id === editingUpdateId) {
      return '<li class="' + (internal ? "t-internal" : "") + '"><div class="t-when">' + fmtDateTime(u.created_at) + "</div>" +
        '<textarea class="up-edit-body" id="up-edit-body">' + escapeHtml(u.body) + "</textarea>" +
        '<label class="chk-label" style="margin:8px 0"><input type="checkbox" id="up-edit-internal"' + (internal ? " checked" : "") +
        ' style="width:auto"> Internal only (hide from customer)</label>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="btn btn-ghost btn-sm" data-up-cancel>Cancel</button>' +
        '<button class="btn btn-primary btn-sm" data-up-save="' + u.id + '">Save</button></div></li>';
    }
    return '<li class="' + (internal ? "t-internal" : "") + '"><div class="t-when">' +
      fmtDateTime(u.created_at) + (mine ? " · you" : " · customer") +
      (u.percent != null ? " · " + u.percent + "%" : "") +
      (internal ? '<span class="t-tag">internal</span>' : "") +
      '<span class="t-acts">' + (mine ? '<button data-edit-up="' + u.id + '">Edit</button>' : "") +
      '<button data-del-up="' + u.id + '">Delete</button></span>' +
      '</div><div class="t-body">' + linkify(u.body) + "</div></li>";
  }).join("");
  const tl2 = $("edit-timeline");
  tl2.querySelectorAll("[data-edit-up]").forEach((b) => b.addEventListener("click", () => { editingUpdateId = b.dataset.editUp; renderEditorTimeline(); }));
  tl2.querySelectorAll("[data-up-cancel]").forEach((b) => b.addEventListener("click", () => { editingUpdateId = null; renderEditorTimeline(); }));
  tl2.querySelectorAll("[data-up-save]").forEach((b) => b.addEventListener("click", () => saveUpdate(b.dataset.upSave)));
  tl2.querySelectorAll("[data-del-up]").forEach((b) => b.addEventListener("click", () => deleteUpdate(b.dataset.delUp)));
}

async function saveUpdate(id) {
  const bodyEl = $("up-edit-body"), intEl = $("up-edit-internal");
  if (!bodyEl) return;
  const body = bodyEl.value.trim();
  if (!body) { toast("Update can't be empty.", "err"); return; }
  editingUpdateId = null;
  const { error } = await sb.from("dd_project_updates").update({ body, customer_visible: !intEl.checked }).eq("id", id);
  if (error) toast(error.message, "err"); else toast("Update saved.", "ok");
  loadEditorTimeline(editingId);
}

async function deleteUpdate(id) {
  if (!confirm("Delete this update? This can't be undone.")) return;
  const { error } = await sb.from("dd_project_updates").delete().eq("id", id);
  if (error) { toast(error.message, "err"); return; }
  toast("Update deleted.", "ok");
  loadEditorTimeline(editingId);
}

$("edit-cancel").addEventListener("click", () => $("edit-modal").classList.remove("show"));
$("edit-modal").addEventListener("click", (e) => {
  if (e.target === $("edit-modal")) $("edit-modal").classList.remove("show");
});

$("edit-save").addEventListener("click", async () => {
  if (!editingId) return;
  const btn = $("edit-save"); btn.disabled = true; $("edit-error").textContent = "";
  const auto = $("e-progress-auto").checked;
  const t = editMilestones.length, d = editMilestones.filter((m) => m.done).length;
  const progress = auto
    ? (t ? Math.round((d / t) * 100) : 0)
    : Math.max(0, Math.min(100, parseInt($("e-progress").value || "0", 10)));
  const patch = {
    title: $("e-name").value.trim(),
    status: $("e-status").value,
    progress_percent: progress,
    progress_auto: auto,
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

// An internal update has no client to notify — keep the two checkboxes coherent.
$("e-update-internal").addEventListener("change", () => {
  const internal = $("e-update-internal").checked;
  const emailBox = $("e-update-email");
  emailBox.disabled = internal;
  if (internal) emailBox.checked = false;
});

$("edit-post").addEventListener("click", async () => {
  if (!editingId) return;
  const body = $("e-update").value.trim();
  if (!body) { $("edit-error").textContent = "Write an update first."; return; }
  const pctRaw = $("e-update-pct").value;
  const percent = pctRaw === "" ? null : Math.max(0, Math.min(100, parseInt(pctRaw, 10)));
  const customer_visible = !$("e-update-internal").checked;
  const emailClient = customer_visible && $("e-update-email").checked;
  const projectId = editingId;
  const btn = $("edit-post"); btn.disabled = true;
  const { error } = await sb.from("dd_project_updates").insert({
    project_id: projectId, body, percent, customer_visible,
  });
  // A percent typed into an update is a manual signal: set it and drop auto mode.
  if (!error && percent != null) {
    await sb.from("dd_projects").update({ progress_percent: percent, progress_auto: false }).eq("id", projectId);
    $("e-progress").value = percent;
    $("e-progress-auto").checked = false;
    $("e-progress").disabled = false;
  }
  btn.disabled = false;
  if (error) { $("edit-error").textContent = error.message; return; }
  $("e-update").value = ""; $("e-update-pct").value = ""; $("e-update-internal").checked = false;
  $("e-update-email").checked = false; $("e-update-email").disabled = false;
  toast("Update posted.", "ok");
  loadEditorTimeline(projectId); loadProjects();
  // Fire-and-report the client email (opt-in). Never blocks the post.
  if (emailClient) {
    const { ok, sent, error: e2 } = await notifyClientUpdate(projectId, body);
    if (ok && sent) toast(sent === 1 ? "Client emailed." : sent + " people emailed.", "ok");
    else if (ok && !sent) toast("Posted — no client email on file to notify.", "ok");
    else toast("Posted, but the email didn't send: " + (e2 || "try again"), "err");
  }
});

/* ---------- attachments upload ---------- */
wireUploader($("e-uploader"), $("e-file-input"), async (files) => {
  if (!editingId) return;
  const zone = $("e-uploader");
  const customerVisible = !$("e-file-internal").checked;
  zone.style.pointerEvents = "none"; zone.style.opacity = ".6";
  const n = await uploadProjectFiles(editingId, files, { customerVisible });
  zone.style.pointerEvents = ""; zone.style.opacity = "";
  if (n) toast(n === 1 ? "File added." : n + " files added.", "ok");
  loadEditorFiles(editingId);
});

$("edit-delete").addEventListener("click", async () => {
  if (!editingId) return;
  if (!confirm("Delete this project and its updates? This can't be undone.")) return;
  // Remove the project's storage objects first — storage.objects has no FK to
  // dd_projects, so deleting the project would otherwise strand its files.
  const { data: objs } = await sb.storage.from(ATTACH_BUCKET).list(editingId, { limit: 1000 });
  if (objs && objs.length) {
    await sb.storage.from(ATTACH_BUCKET).remove(objs.map((o) => editingId + "/" + o.name));
  }
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
  // Email the client an invite with a sign-in link (also records their access).
  const { ok, error: e2 } = await shareInvite(proj.id, email);
  btn.disabled = false;
  if (!ok) { $("new-error").textContent = "Project created, but the invite email failed: " + (e2 || ""); return; }
  $("new-modal").classList.remove("show");
  toast("Project created — invite emailed to " + email, "ok");
  loadProjects();
});

/* ---------- realtime ---------- */
function subscribe() {
  if (channel) return;
  const refresh = () => { loadInbox(); loadProjects(); if (editingId && $("edit-modal").classList.contains("show")) loadEditorTimeline(editingId); };
  channel = sb.channel("dd-admin")
    .on("postgres_changes", { event: "*", schema: "public", table: "dd_projects" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "dd_project_updates" }, () => { if (editingId && $("edit-modal").classList.contains("show")) loadEditorTimeline(editingId); })
    .on("postgres_changes", { event: "*", schema: "public", table: "dd_project_files" }, () => { if (editingId && $("edit-modal").classList.contains("show")) loadEditorFiles(editingId); })
    .on("postgres_changes", { event: "*", schema: "public", table: "dd_milestones" }, () => { if (editingId && $("edit-modal").classList.contains("show")) loadEditorMilestones(editingId); })
    .on("postgres_changes", { event: "*", schema: "public", table: "dd_inquiries" }, loadInbox)
    .subscribe();
}
function teardown() { if (channel) { sb.removeChannel(channel); channel = null; } }
