/* ============================================================
 * DeSmit Designs portal — shared Supabase client + helpers
 * Imported by portal.js (customer) and ../admin/admin.js (owner).
 * ============================================================ */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CFG = window.DD_CONFIG || {};
export const CONFIGURED =
  CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf("REPLACE_ME") === -1 &&
  CFG.SUPABASE_ANON_KEY && CFG.SUPABASE_ANON_KEY.indexOf("REPLACE_ME") === -1;

export const sb = CONFIGURED
  ? createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY)
  : null;

export const REDIRECT = CFG.PORTAL_REDIRECT ||
  (location.origin + location.pathname);

/* status → human label + ordered pipeline */
export const STATUS_LABEL = {
  requested: "Requested",
  quoted: "Quote ready",
  approved: "Approved",
  in_progress: "In progress",
  review: "In review",
  complete: "Complete",
  cancelled: "Cancelled",
};
export const STATUS_ORDER = [
  "requested", "quoted", "approved", "in_progress", "review", "complete", "cancelled",
];

export function money(n) {
  if (n == null || n === "") return null;
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
export function toast(msg, kind) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 3200);
}

export function showView(id) {
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("active", v.id === id));
  window.scrollTo({ top: 0 });
}

/* ============================================================
 * Project attachments (photos + files) — shared by portal + admin.
 * Files live in the private `dd-attachments` bucket; metadata in
 * dd_project_files. RLS keys on project access + customer_visible.
 * ============================================================ */
export const ATTACH_BUCKET = "dd-attachments";
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Render inline only real raster/vector images, never svg (svg can carry
// script). Everything else is served as a download (see loadProjectFiles).
const isInlineImage = (mime) =>
  (mime || "").startsWith("image/") && mime !== "image/svg+xml";

export function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toUpperCase() : "FILE";
}

/* Upload a FileList into a project's folder, then record metadata. Returns the
   number stored. customerVisible=false marks an admin-only (internal) file. */
export async function uploadProjectFiles(projectId, fileList, opts = {}) {
  const customerVisible = opts.customerVisible !== false;
  const files = Array.from(fileList).slice(0, 20);
  let stored = 0;
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) { toast(f.name + " is over 25 MB — skipped.", "err"); continue; }
    const safe = f.name.replace(/[^\w.\-]+/g, "_").slice(-60);
    const path = projectId + "/" + crypto.randomUUID() + "-" + safe;
    const ct = f.type || "application/octet-stream";
    const { error } = await sb.storage.from(ATTACH_BUCKET).upload(path, f, { contentType: ct, upsert: false });
    if (error) { toast("Couldn't upload " + f.name + ".", "err"); continue; }
    const row = { project_id: projectId, storage_path: path, filename: f.name, mime: f.type || null, size_bytes: f.size };
    if (!customerVisible) row.customer_visible = false;
    const { error: e2 } = await sb.from("dd_project_files").insert(row);
    if (e2) {
      // metadata failed — remove the orphan object we just created
      await sb.storage.from(ATTACH_BUCKET).remove([path]);
      toast("Couldn't save " + f.name + ".", "err");
      continue;
    }
    stored++;
  }
  return stored;
}

/* Fetch a project's files (RLS returns only what the caller may see) and sign a
   short-lived URL for each. Non-images sign with { download } so they arrive as
   an attachment rather than rendering on the Supabase origin. */
export async function loadProjectFiles(projectId) {
  const { data, error } = await sb
    .from("dd_project_files").select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  await Promise.all(data.map(async (a) => {
    a.inline = isInlineImage(a.mime);
    const options = a.inline ? undefined : { download: a.filename || true };
    const { data: s } = await sb.storage.from(ATTACH_BUCKET).createSignedUrl(a.storage_path, 3600, options);
    a.url = s ? s.signedUrl : null;
  }));
  return data;
}

/* Delete an attachment: object FIRST (the storage delete policy needs the
   metadata row present), then the row. */
export async function deleteAttachment(file) {
  await sb.storage.from(ATTACH_BUCKET).remove([file.storage_path]);
  const { error } = await sb.from("dd_project_files").delete().eq("id", file.id);
  return { ok: !error, error: error && error.message };
}

/* Render attachment thumbnails into a container. opts:
     canDelete(file) -> bool, showInternal -> bool, onDelete(id) -> void */
export function renderAttachments(container, files, opts = {}) {
  if (!files.length) {
    container.innerHTML = '<div class="inline-note" style="grid-column:1/-1">No files yet.</div>';
    return;
  }
  const canDelete = opts.canDelete || (() => false);
  container.innerHTML = files.map((a) => {
    const internal = opts.showInternal && a.customer_visible === false;
    const cls = internal ? " internal" : "";
    const del = canDelete(a) ? '<button class="rm" data-del="' + a.id + '" title="Remove">&times;</button>' : "";
    const tag = internal ? '<span class="tag">internal</span>' : "";
    if (a.inline && a.url) {
      return '<a class="thumb' + cls + '" href="' + a.url + '" target="_blank" rel="noopener">' +
        '<img src="' + a.url + '" alt="' + escapeHtml(a.filename || "image") + '" loading="lazy">' +
        del + tag + "</a>";
    }
    const inner =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 3v5h5"/><path d="M8 3h6l4.5 4.5V20a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>' +
      '<span class="ext">' + escapeHtml(fileExt(a.filename)) + "</span>" +
      "<span>" + escapeHtml((a.filename || "file").slice(0, 22)) + "</span>";
    return '<a class="thumb file' + cls + '" href="' + (a.url || "#") + '"' + (a.url ? " download" : "") +
      (a.url ? "" : ' aria-disabled="true"') + ">" + inner + del + tag + "</a>";
  }).join("");
  container.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); opts.onDelete(b.dataset.del); }));
}

// A page only receives file `drop` events if the document's default
// drag-over/drop (which navigates to the dropped file) is suppressed. Do it
// once per page so a drop that lands even a pixel outside the zone doesn't
// open the file in the browser.
let _dropGuardInstalled = false;
function installDropGuard() {
  if (_dropGuardInstalled) return;
  _dropGuardInstalled = true;
  ["dragover", "drop"].forEach((ev) =>
    window.addEventListener(ev, (e) => { e.preventDefault(); }, false));
}

/* Wire a dropzone + hidden file input to an upload handler. */
export function wireUploader(zoneEl, inputEl, onFiles) {
  if (!zoneEl || !inputEl) return;
  installDropGuard();
  zoneEl.addEventListener("click", () => inputEl.click());
  zoneEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputEl.click(); } });
  inputEl.addEventListener("change", () => { if (inputEl.files.length) { onFiles(inputEl.files); inputEl.value = ""; } });
  ["dragenter", "dragover"].forEach((ev) =>
    zoneEl.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); zoneEl.classList.add("drag"); }));
  zoneEl.addEventListener("dragleave", (e) => { e.preventDefault(); zoneEl.classList.remove("drag"); });
  zoneEl.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    zoneEl.classList.remove("drag");
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) onFiles(files);
    else toast("No file detected in that drop — try the click option.", "err");
  });
}

/* ============================================================
 * Milestones — studio-managed checklist per project (client reads).
 * ============================================================ */
export const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

export async function loadMilestones(projectId) {
  const { data } = await sb
    .from("dd_milestones").select("*")
    .eq("project_id", projectId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  return data || [];
}

/* Email a project's client(s) that a new update was posted, via the
   notify-update Edge Function. Opt-in per update. Returns { ok, sent, error }. */
export async function notifyClientUpdate(projectId, message) {
  try {
    const { data } = await sb.auth.getSession();
    const res = await fetch(CFG.SUPABASE_URL + "/functions/v1/notify-update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: CFG.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + (data && data.session ? data.session.access_token : ""),
      },
      body: JSON.stringify({ project_id: projectId, message: message || "" }),
    });
    const b = await res.json().catch(() => ({}));
    return { ok: res.ok, sent: b && b.sent, error: b && b.error };
  } catch (e) {
    return { ok: false, error: "Network error — please try again." };
  }
}

/* Share a project with someone by email via the send-invite Edge Function
   (records the share AND emails them a magic sign-in link). Returns
   { ok, error }. */
export async function shareInvite(projectId, email) {
  try {
    const { data } = await sb.auth.getSession();
    const res = await fetch(CFG.SUPABASE_URL + "/functions/v1/send-invite", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: CFG.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + (data && data.session ? data.session.access_token : ""),
      },
      body: JSON.stringify({ project_id: projectId, email }),
    });
    const b = await res.json().catch(() => ({}));
    return { ok: res.ok, error: b && b.error };
  } catch (e) {
    return { ok: false, error: "Network error — please try again." };
  }
}
