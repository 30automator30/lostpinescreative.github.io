/* ============================================================
 * DeSmit Designs portal — configuration (single source of truth)
 *
 * Fill these three values AFTER the dedicated Supabase project exists.
 *   SUPABASE_URL      → Project Settings ▸ API ▸ Project URL
 *   SUPABASE_ANON_KEY → Project Settings ▸ API ▸ anon / publishable key
 *                       (safe to ship publicly — Row-Level Security guards data)
 *   ASSISTANT_FN      → `${SUPABASE_URL}/functions/v1/dd-assistant`
 *
 * Nothing else in the portal, admin, or assistant needs editing.
 * ============================================================ */
window.DD_CONFIG = {
  SUPABASE_URL: "https://ekogelnbhggyrychfrta.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrb2dlbG5iaGdneXJ5Y2hmcnRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczMjAwNzUsImV4cCI6MjEwMjg5NjA3NX0.0AC8vY8A-oPj-hArn_PY5jPRAGcc2mgfu5SV2wqSxP0",
  ASSISTANT_FN: "https://ekogelnbhggyrychfrta.supabase.co/functions/v1/ai-receptionist",
  // Where the magic-link email should return the user. Must be listed under
  // Auth ▸ URL Configuration ▸ Redirect URLs in the Supabase project.
  PORTAL_REDIRECT: "https://lostpinescreative.com/desmitdesigns/portal/",
};
