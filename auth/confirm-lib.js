/* ============================================================
 * Email-link landing rules for /auth/confirm.html (pure, unit-tested).
 *
 * Every Supabase email (confirm sign-up, magic link, reset password, invite,
 * email change) links to /auth/confirm.html?token_hash=…&type=…&next=…
 * `next` is the redirect the app/portal asked for. Only our own site and the
 * Lost Pines app may receive the user — anything else falls back to the home
 * page, so the link can't be used as an open redirect.
 * ============================================================ */

export const OTP_TYPES = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];
const SITE_HOSTS = ["lostpinescreative.com", "www.lostpinescreative.com"];
// The app's one auth entry point. Anything else under the scheme is refused.
export const APP_TARGET = "lostpines://auth";

/** Where to send the user: {kind: "app"|"web", url} — never another site. */
export function resolveNext(next, origin) {
  const raw = String(next || "").trim();
  if (raw === APP_TARGET) return { kind: "app", url: APP_TARGET };
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

/** The app verifies the one-time token itself, so hand it over untouched. */
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
