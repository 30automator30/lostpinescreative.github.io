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
