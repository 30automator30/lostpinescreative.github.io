/* ============================================================
 * Groundwork portal — shared Supabase client + helpers.
 * Imported by portal.js (client) and ../admin/admin.js (owner).
 * ============================================================ */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CFG = window.GW_CONFIG || {};
export const CONFIGURED =
  CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf("REPLACE_ME") === -1 &&
  CFG.SUPABASE_ANON_KEY && CFG.SUPABASE_ANON_KEY.indexOf("REPLACE_ME") === -1;

export const sb = CONFIGURED ? createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
export const REDIRECT = CFG.PORTAL_REDIRECT || (location.origin + location.pathname);

export const CARE_LABEL = {
  essential: "Essential care",
  growth: "Growth care",
  partner: "Partner",
  none: "No care plan",
};
export const STATUS_LABEL = {
  onboarding: "Onboarding",
  active: "Active",
  paused: "Paused",
  cancelled: "Cancelled",
};
export const INT_STATUS = {
  planned: "Planned",
  in_progress: "In progress",
  live: "Live",
  paused: "Paused",
};
export const MSG_KIND = {
  voicemail: "Voicemail",
  missed_call: "Missed call",
  textback: "Text-back",
  lead: "Lead",
  form: "Form",
};

export function money(n) {
  if (n == null || n === "") return null;
  return "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
export function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export function fmtDateTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Escape HTML, then turn http(s) URLs into links (XSS-safe: escape runs first). */
export function linkify(s) {
  return escapeHtml(s).replace(/(https?:\/\/[^\s<]+)/g, (m) => {
    const trail = (m.match(/[.,;:!?)\]]+$/) || [""])[0];
    const url = m.slice(0, m.length - trail.length);
    return '<a href="' + url + '" target="_blank" rel="noopener">' + url + "</a>" + trail;
  });
}

/* ============================================================
 * Attachments (gw_files / gw-attachments bucket) + activity timeline.
 * Access is keyed on gw_owns_client + client_visible via RLS.
 * ============================================================ */
export const ATTACH_BUCKET = "gw-attachments";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const isInlineImage = (mime) => (mime || "").startsWith("image/") && mime !== "image/svg+xml";

export const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

export function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toUpperCase() : "FILE";
}

export async function uploadClientFiles(clientId, fileList, opts = {}) {
  const clientVisible = opts.clientVisible !== false;
  const files = Array.from(fileList).slice(0, 20);
  let stored = 0;
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) { toast(f.name + " is over 25 MB — skipped.", "err"); continue; }
    const safe = f.name.replace(/[^\w.\-]+/g, "_").slice(-60);
    const path = clientId + "/" + crypto.randomUUID() + "-" + safe;
    const { error } = await sb.storage.from(ATTACH_BUCKET).upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
    if (error) { toast("Couldn't upload " + f.name + ".", "err"); continue; }
    const row = { client_id: clientId, storage_path: path, filename: f.name, mime: f.type || null, size_bytes: f.size };
    if (!clientVisible) row.client_visible = false;
    const { error: e2 } = await sb.from("gw_files").insert(row);
    if (e2) { await sb.storage.from(ATTACH_BUCKET).remove([path]); toast("Couldn't save " + f.name + ".", "err"); continue; }
    stored++;
  }
  return stored;
}

export async function loadClientFiles(clientId) {
  const { data, error } = await sb.from("gw_files").select("*")
    .eq("client_id", clientId).order("created_at", { ascending: false });
  if (error || !data) return [];
  await Promise.all(data.map(async (a) => {
    a.inline = isInlineImage(a.mime);
    const options = a.inline ? undefined : { download: a.filename || true };
    const { data: s } = await sb.storage.from(ATTACH_BUCKET).createSignedUrl(a.storage_path, 3600, options);
    a.url = s ? s.signedUrl : null;
  }));
  return data;
}

export async function deleteAttachment(file) {
  await sb.storage.from(ATTACH_BUCKET).remove([file.storage_path]);
  const { error } = await sb.from("gw_files").delete().eq("id", file.id);
  return { ok: !error, error: error && error.message };
}

export function renderAttachments(container, files, opts = {}) {
  if (!files.length) { container.innerHTML = '<div class="inline-note" style="grid-column:1/-1">No files yet.</div>'; return; }
  const canDelete = opts.canDelete || (() => false);
  container.innerHTML = files.map((a) => {
    const internal = opts.showInternal && a.client_visible === false;
    const cls = internal ? " internal" : "";
    const del = canDelete(a) ? '<button class="rm" data-del="' + a.id + '" title="Remove">&times;</button>' : "";
    const tag = internal ? '<span class="tag">internal</span>' : "";
    if (a.inline && a.url) {
      return '<a class="thumb' + cls + '" href="' + a.url + '" target="_blank" rel="noopener">' +
        '<img src="' + a.url + '" alt="' + escapeHtml(a.filename || "image") + '" loading="lazy">' + del + tag + "</a>";
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

let _dropGuard = false;
function installDropGuard() {
  if (_dropGuard) return; _dropGuard = true;
  ["dragover", "drop"].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault(), false));
}
export function wireUploader(zoneEl, inputEl, onFiles) {
  if (!zoneEl || !inputEl) return;
  installDropGuard();
  zoneEl.addEventListener("click", () => inputEl.click());
  zoneEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputEl.click(); } });
  inputEl.addEventListener("change", () => { if (inputEl.files.length) { onFiles(inputEl.files); inputEl.value = ""; } });
  ["dragenter", "dragover"].forEach((ev) => zoneEl.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); zoneEl.classList.add("drag"); }));
  zoneEl.addEventListener("dragleave", (e) => { e.preventDefault(); zoneEl.classList.remove("drag"); });
  zoneEl.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation(); zoneEl.classList.remove("drag");
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) onFiles(files);
    else toast("No file detected in that drop — try the click option.", "err");
  });
}

export async function loadClientUpdates(clientId) {
  const { data } = await sb.from("gw_updates").select("*")
    .eq("client_id", clientId).order("created_at", { ascending: false });
  return data || [];
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
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id));
  window.scrollTo({ top: 0 });
}
