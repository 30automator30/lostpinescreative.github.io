/* ============================================================
 * DeSmit Designs — customer portal logic
 * Magic-link auth · live project tracking · quote approval · requests.
 * ============================================================ */
import {
  sb, CONFIGURED, REDIRECT, STATUS_LABEL, money, fmtDate, fmtDateTime,
  escapeHtml, toast, showView, shareInvite,
  uploadProjectFiles, loadProjectFiles, deleteAttachment, renderAttachments, wireUploader,
  loadMilestones, CHECK_SVG,
} from "./client.js";
import { initAuth, isRecovering } from "/portal-auth.js";

const $ = (id) => document.getElementById(id);

let user = null;
let dashChannel = null;   // realtime on all my projects
let pjChannel = null;     // realtime on the open project's updates
let openProjectId = null;
let currentProject = null; // the row for the open project
let currentFiles = [];     // dd_project_files rows for the open project

/* ---------- boot ---------- */
if (!CONFIGURED) {
  showView("view-auth");
  $("auth-error").textContent =
    "The portal isn't connected yet — the studio is finishing setup. Email ddesmit@lostpinescreative.com in the meantime.";
  $("auth-form").querySelectorAll("input,button").forEach((el) => (el.disabled = true));
} else {
  initAuth(sb, REDIRECT);
  sb.auth.getSession().then(({ data }) => routeSession(data.session));
  // Defer out of the callback: awaiting a Supabase call *inside* the
  // onAuthStateChange handler deadlocks on its internal auth lock. setTimeout
  // releases the lock first so routeSession's queries can run.
  sb.auth.onAuthStateChange((_evt, session) => { setTimeout(() => routeSession(session), 0); });
}

function routeSession(session) {
  if (isRecovering()) return;
  if (session && session.user) {
    if (user && user.id === session.user.id) return; // already set up
    user = session.user;
    $("who").textContent = user.email;
    $("signout").style.display = "";
    enterDashboard();
  } else {
    user = null;
    $("signout").style.display = "none";
    $("who").textContent = "";
    teardownRealtime();
    showView("view-auth");
  }
}

/* ---------- auth (email + password wired in /portal-auth.js) ---------- */
$("signout").addEventListener("click", async () => { await sb.auth.signOut(); });

/* ---------- dashboard ---------- */
async function enterDashboard() {
  showView("view-dash");
  await loadProjects();
  subscribeDashboard();
}

async function loadProjects() {
  const list = $("dash-list");
  list.innerHTML = '<div class="spinner"></div>';
  const { data, error } = await sb
    .from("dd_projects")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) {
    list.innerHTML = '<div class="empty">Couldn\'t load your projects. Please refresh.</div>';
    return;
  }
  if (!data.length) {
    list.innerHTML =
      '<div class="empty">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/></svg>' +
      "<p>No projects yet. Click <b>Request a service</b> to start one — Daniel will reply with a quote you'll see right here.</p></div>";
    return;
  }
  list.innerHTML = '<div class="cards">' + data.map(card).join("") + "</div>";
  list.querySelectorAll(".card.click").forEach((el) =>
    el.addEventListener("click", () => openProject(el.dataset.id)));
}

function card(p) {
  const q = money(p.quote_amount);
  const shared = p.customer_id !== user.id;
  return (
    '<div class="card click" data-id="' + p.id + '">' +
    '<div class="row"><h3 style="flex:1">' + escapeHtml(p.title) +
    (shared ? ' <span class="badge approved" style="font-size:.62rem;vertical-align:middle">shared with you</span>' : "") + "</h3>" +
    '<span class="badge ' + p.status + '">' + STATUS_LABEL[p.status] + "</span></div>" +
    '<div class="meta">' + escapeHtml(p.service_type || "Project") + " · started " + fmtDate(p.created_at) + "</div>" +
    '<div class="row"><div class="bar"><span style="width:' + (p.progress_percent || 0) + '%"></span></div>' +
    '<span class="pct">' + (p.progress_percent || 0) + "%</span></div>" +
    (q && (p.status === "quoted" || p.status === "approved")
      ? '<div class="row" style="margin-top:10px"><span class="subtle">Quote:</span> <b style="color:var(--accent-light)">' + q + "</b>" +
        (p.status === "quoted" ? ' <span class="badge quoted" style="margin-left:auto">Awaiting your OK</span>' : "") + "</div>"
      : "") +
    "</div>"
  );
}

function subscribeDashboard() {
  if (dashChannel) return;
  dashChannel = sb
    .channel("dd-my-projects")
    .on("postgres_changes",
      { event: "*", schema: "public", table: "dd_projects", filter: "customer_id=eq." + user.id },
      () => { if ($("view-dash").classList.contains("active")) loadProjects(); })
    .subscribe();
}

/* ---------- project detail ---------- */
async function openProject(id) {
  openProjectId = id;
  showView("view-project");
  $("pj-timeline").innerHTML = '<div class="spinner"></div>';
  $("pj-files").innerHTML = "";
  $("pj-milestones").innerHTML = "";
  await renderProject();
  loadFiles(id);
  loadMilestonesView(id);
  subscribeProject(id);
}

async function loadMilestonesView(id) {
  if (id !== openProjectId) return;
  const list = await loadMilestones(id);
  if (id !== openProjectId) return;
  const card = $("pj-mstones-card");
  if (!list.length) { card.style.display = "none"; return; }
  card.style.display = "";
  const done = list.filter((m) => m.done).length;
  $("pj-ms-count").textContent = done + " of " + list.length + " complete";
  $("pj-milestones").innerHTML = list.map((m) =>
    '<li class="' + (m.done ? "done" : "") + '">' +
    '<span class="ms-check' + (m.done ? " done" : "") + '">' + (m.done ? CHECK_SVG : "") + "</span>" +
    '<span class="ms-title">' + escapeHtml(m.title) + "</span></li>").join("");
}

async function loadFiles(id) {
  if (id !== openProjectId) return;
  currentFiles = await loadProjectFiles(id);
  if (id !== openProjectId) return; // guard against a race with a fast back-click
  renderAttachments($("pj-files"), currentFiles, {
    canDelete: (a) => a.uploaded_by === user.id,
    showInternal: false,
    onDelete: async (fid) => {
      const f = currentFiles.find((x) => x.id === fid);
      if (!f || !confirm("Remove " + (f.filename || "this file") + "?")) return;
      const { ok } = await deleteAttachment(f);
      if (!ok) { toast("Couldn't remove that file.", "err"); return; }
      toast("File removed.", "ok");
      loadFiles(openProjectId);
    },
  });
}

async function renderProject() {
  const id = openProjectId;
  const { data: p, error } = await sb.from("dd_projects").select("*").eq("id", id).single();
  if (error || !p) { toast("Couldn't load that project.", "err"); backToDash(); return; }
  currentProject = p;

  $("pj-title").textContent = p.title;
  $("pj-sub").textContent = (p.service_type || "Project") + " · started " + fmtDate(p.created_at);
  const badge = $("pj-badge");
  badge.className = "badge " + p.status;
  badge.textContent = STATUS_LABEL[p.status];
  $("pj-bar").style.width = (p.progress_percent || 0) + "%";
  $("pj-pct").textContent = (p.progress_percent || 0) + "%";
  $("pj-desc").textContent = p.description || "No description yet.";

  // quote block
  const qw = $("pj-quote-wrap");
  const q = money(p.quote_amount);
  if (q && (p.status === "quoted" || p.status === "approved" ||
            p.status === "in_progress" || p.status === "review" || p.status === "complete")) {
    qw.innerHTML =
      '<div class="quote"><div class="row"><div style="flex:1">' +
      '<div class="subtle">Quoted total</div><div class="amt">' + q + "</div>" +
      (p.quote_notes ? "<p>" + escapeHtml(p.quote_notes) + "</p>" : "") + "</div>" +
      (p.status === "quoted"
        ? '<button class="btn btn-primary" id="approve-btn">Approve &amp; start</button>'
        : p.status === "approved"
          ? '<span class="badge approved">Approved — queued</span>'
          : "") +
      "</div></div>";
    const ab = $("approve-btn");
    if (ab) ab.addEventListener("click", () => approveQuote(id, ab));
  } else {
    qw.innerHTML = "";
  }

  // timeline
  const { data: ups } = await sb
    .from("dd_project_updates")
    .select("*")
    .eq("project_id", id)
    .order("created_at", { ascending: false });
  const tl = $("pj-timeline");
  if (!ups || !ups.length) {
    tl.innerHTML = '<li><div class="t-body subtle">No updates yet — you\'ll see progress here as Daniel works.</div></li>';
  } else {
    tl.innerHTML = ups.map((u) => {
      const mine = u.author_id === user.id;
      return '<li><div class="t-when">' + fmtDateTime(u.created_at) +
        (mine ? " · you" : "") +
        (u.percent != null ? " · " + u.percent + "%" : "") + "</div>" +
        '<div class="t-body ' + (mine ? "t-you" : "") + '">' + escapeHtml(u.body) + "</div></li>";
    }).join("");
  }
}

async function approveQuote(id, btn) {
  btn.disabled = true;
  const { error } = await sb.rpc("dd_approve_quote", { p_project: id });
  if (error) { toast(error.message || "Couldn't approve.", "err"); btn.disabled = false; return; }
  toast("Quote approved — Daniel has been notified.", "ok");
  renderProject();
}

$("pj-note-send").addEventListener("click", async () => {
  const ta = $("pj-note");
  const body = ta.value.trim();
  if (!body || !openProjectId) return;
  const btn = $("pj-note-send");
  btn.disabled = true;
  const { error } = await sb.from("dd_project_updates").insert({ project_id: openProjectId, body });
  btn.disabled = false;
  if (error) { toast("Couldn't send your note.", "err"); return; }
  ta.value = "";
  toast("Note sent.", "ok");
  renderProject();
});

/* ---------- attachments upload ---------- */
wireUploader($("pj-uploader"), $("pj-file-input"), async (files) => {
  if (!openProjectId) return;
  const zone = $("pj-uploader");
  zone.style.pointerEvents = "none"; zone.style.opacity = ".6";
  const n = await uploadProjectFiles(openProjectId, files);
  zone.style.pointerEvents = ""; zone.style.opacity = "";
  if (n) toast(n === 1 ? "File added." : n + " files added.", "ok");
  loadFiles(openProjectId);
});

function subscribeProject(id) {
  teardownProjectChannel();
  pjChannel = sb
    .channel("dd-project-" + id)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "dd_project_updates", filter: "project_id=eq." + id },
      () => { if (openProjectId === id) renderProject(); })
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "dd_projects", filter: "id=eq." + id },
      () => { if (openProjectId === id) renderProject(); })
    .on("postgres_changes",
      { event: "*", schema: "public", table: "dd_project_files", filter: "project_id=eq." + id },
      () => { if (openProjectId === id) loadFiles(id); })
    .on("postgres_changes",
      { event: "*", schema: "public", table: "dd_milestones", filter: "project_id=eq." + id },
      () => { if (openProjectId === id) loadMilestonesView(id); })
    .subscribe();
}

function backToDash() {
  openProjectId = null;
  teardownProjectChannel();
  showView("view-dash");
  loadProjects();
}
$("back-dash").addEventListener("click", backToDash);

/* ---------- share a project ---------- */
$("pj-share").addEventListener("click", () => {
  if (!openProjectId) return;
  $("share-error").textContent = "";
  $("share-email").value = "";
  loadShares();
  $("share-modal").classList.add("show");
});
$("share-close").addEventListener("click", () => $("share-modal").classList.remove("show"));
$("share-modal").addEventListener("click", (e) => {
  if (e.target === $("share-modal")) $("share-modal").classList.remove("show");
});

async function loadShares() {
  const box = $("share-list");
  box.innerHTML = '<div class="subtle" style="font-size:.85rem">Loading…</div>';
  const isOwner = currentProject && currentProject.customer_id === user.id;
  const { data, error } = await sb
    .from("dd_project_shares")
    .select("email,user_id")
    .eq("project_id", openProjectId)
    .order("created_at", { ascending: true });
  if (error) { box.innerHTML = '<div class="subtle">Couldn\'t load who has access.</div>'; return; }
  if (!data.length) { box.innerHTML = '<div class="subtle" style="font-size:.85rem">Not shared with anyone yet.</div>'; return; }
  box.innerHTML = data.map((s) =>
    '<div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">' +
    '<span>' + escapeHtml(s.email) +
    (s.user_id ? ' <span class="badge complete" style="font-size:.6rem">active</span>'
               : ' <span class="badge quoted" style="font-size:.6rem">invited</span>') + "</span>" +
    (isOwner ? '<button class="btn btn-danger btn-sm" data-remove="' + encodeURIComponent(s.email) + '">Remove</button>' : "") +
    "</div>").join("");
  box.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      const { error: e2 } = await sb.rpc("dd_unshare_project", {
        p_project: openProjectId, p_email: decodeURIComponent(b.dataset.remove),
      });
      if (e2) { toast("Couldn't remove.", "err"); b.disabled = false; return; }
      loadShares();
    }));
}

$("share-add").addEventListener("click", async () => {
  const email = $("share-email").value.trim();
  if (!email) return;
  const btn = $("share-add");
  btn.disabled = true;
  $("share-error").textContent = "";
  const { ok, error } = await shareInvite(openProjectId, email);
  btn.disabled = false;
  if (!ok) { $("share-error").textContent = error || "Couldn't share."; return; }
  $("share-email").value = "";
  toast("Invite sent — they'll get an email with a sign-in link.", "ok");
  loadShares();
});

/* ---------- request a service ---------- */
$("new-req").addEventListener("click", () => {
  $("req-error").textContent = "";
  $("req-form").reset();
  $("req-modal").classList.add("show");
});
$("req-cancel").addEventListener("click", () => $("req-modal").classList.remove("show"));
$("req-modal").addEventListener("click", (e) => {
  if (e.target === $("req-modal")) $("req-modal").classList.remove("show");
});
$("req-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("req-title").value.trim();
  const service_type = $("req-service").value;
  const description = $("req-desc").value.trim();
  if (!title || !description) return;
  const btn = $("req-submit");
  btn.disabled = true;
  $("req-error").textContent = "";
  // trigger forces customer_id + status='requested' server-side.
  const { error } = await sb.from("dd_projects").insert({ title, service_type, description, customer_id: user.id });
  btn.disabled = false;
  if (error) { $("req-error").textContent = error.message || "Couldn't submit. Try again."; return; }
  $("req-modal").classList.remove("show");
  toast("Request sent — Daniel will reply with a quote.", "ok");
  loadProjects();
});

/* ---------- cleanup ---------- */
function teardownProjectChannel() {
  if (pjChannel) { sb.removeChannel(pjChannel); pjChannel = null; }
}
function teardownRealtime() {
  teardownProjectChannel();
  if (dashChannel) { sb.removeChannel(dashChannel); dashChannel = null; }
}
