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
