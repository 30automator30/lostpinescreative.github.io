/* ============================================================
 * Groundwork portal — configuration.
 * Reuses the SAME Supabase project as DeSmit Designs (one backend), so the
 * URL + anon key match desmitdesigns/portal/config.js. Only the assistant
 * function and the portal redirect are Groundwork-specific.
 * ============================================================ */
window.GW_CONFIG = {
  SUPABASE_URL: "https://ekogelnbhggyrychfrta.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrb2dlbG5iaGdneXJ5Y2hmcnRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczMjAwNzUsImV4cCI6MjEwMjg5NjA3NX0.0AC8vY8A-oPj-hArn_PY5jPRAGcc2mgfu5SV2wqSxP0",
  ASSISTANT_FN: "https://ekogelnbhggyrychfrta.supabase.co/functions/v1/gw-assistant",
  PORTAL_REDIRECT: "https://lostpinescreative.com/groundwork/portal/",
};
