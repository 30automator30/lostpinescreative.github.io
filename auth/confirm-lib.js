/* ============================================================
 * Email-link landing rules for /auth/confirm.html (pure, unit-tested).
 *
 * Every Supabase email (confirm sign-up, magic link, reset password, invite,
 * email change) links to /auth/confirm.html?token_hash=…&type=…&next=…
 * `next` is the redirect the app/portal asked for. Only our own site and the
 * Lost Pines app may receive the user — anything else falls back to the home
 * page, so the link can't be used as an open redirect.
 *
 * The app is reached only through its verified link APP_LINK (Android App
 * Links / iOS Universal Links, see /.well-known/), never a custom scheme: any
 * app can claim `lostpines://`, but only our signed app can open APP_LINK.
 * Emails for the app normally link to APP_LINK directly (email templates);
 * this page only forwards to it if an older link lands here.
 * ============================================================ */

export const OTP_TYPES = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];
const SITE_HOSTS = ["lostpinescreative.com", "www.lostpinescreative.com"];
// The app's one verified auth entry point.
export const APP_LINK = "https://lostpinescreative.com/auth/app";
const APP_LINK_ALIASES = [APP_LINK, "https://www.lostpinescreative.com/auth/app"];

/** Where to send the user: {kind: "app"|"web", url} — never another site. */
export function resolveNext(next, origin) {
  const raw = String(next || "").trim();
  if (APP_LINK_ALIASES.includes(raw)) return { kind: "app", url: APP_LINK };
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) {
    return { kind: "web", url: origin + raw };
  }
  try {
    const u = new URL(raw);
    const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname) && new URL(origin).hostname === u.hostname;
    if ((u.protocol === "https:" && SITE_HOSTS.includes(u.hostname)) || local) return { kind: "web", url: u.href };
  } catch (_) { /* not a URL */ }
  return { kind: "web", url: origin + "/" };
}

/** The app verifies the one-time token itself, so hand it over untouched (same site only). */
export function appUrl(appTarget, tokenHash, type) {
  const sep = appTarget.includes("?") ? "&" : "?";
  return appTarget + sep + "token_hash=" + encodeURIComponent(tokenHash) + "&type=" + encodeURIComponent(type);
}

/** After a web reset-password link, the portal opens its "set a new password" view. */
export function webUrl(target, type) {
  const u = target.split("#")[0];
  return type === "recovery" ? u + "#lpc-recovery" : u;
}

/** Parse the query string; null when the link is malformed. */
export function parseLink(search) {
  const q = new URLSearchParams(search);
  const tokenHash = q.get("token_hash") || "";
  const type = q.get("type") || "";
  if (!/^[A-Za-z0-9_-]{6,200}$/.test(tokenHash) || !OTP_TYPES.includes(type)) return null;
  return { tokenHash, type, next: q.get("next") || "" };
}
