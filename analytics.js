/* Lost Pines Creative — shared Google Analytics 4 + cookie consent.
 *
 * One file, included on every page via <script src="/analytics.js"></script>,
 * managing GA4 for the whole lostpinescreative.com property.
 *
 * Privacy model: Google Consent Mode v2. analytics_storage is DENIED by
 * default, so no analytics cookies are set until the visitor clicks Accept.
 * Until then GA sends only cookieless, consent-signaled pings. A visitor's
 * choice (accept/decline) is remembered in localStorage; the banner shows
 * only until they choose.
 */
(function () {
  "use strict";
  var ID = "G-80VW0JE7HW";
  var KEY = "lpc-consent"; // "granted" | "denied"

  // --- gtag bootstrap + Consent Mode v2 defaults (must run before config) ---
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { dataLayer.push(arguments); };

  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}

  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: stored === "granted" ? "granted" : "denied",
    wait_for_update: 500,
  });

  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
  document.head.appendChild(s);

  gtag("js", new Date());
  gtag("config", ID);

  function grant() {
    gtag("consent", "update", { analytics_storage: "granted" });
  }
  if (stored === "granted") grant();

  // --- consent banner (shown only if no choice stored yet) ---
  if (stored === "granted" || stored === "denied") return;

  function build() {
    if (document.getElementById("lpc-consent")) return;

    var css =
      "#lpc-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:2147482000;" +
      "max-width:680px;margin:0 auto;background:#0f1720;color:#e6edf3;border:1px solid #2a3644;" +
      "border-radius:12px;box-shadow:0 16px 40px -12px rgba(0,0,0,.6);padding:16px 18px;" +
      "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:.9rem;line-height:1.5;" +
      "display:flex;gap:14px;align-items:center;flex-wrap:wrap;animation:lpc-cc-in .3s ease}" +
      "@keyframes lpc-cc-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}" +
      "#lpc-consent p{margin:0;flex:1;min-width:220px;color:#c9d4de}" +
      "#lpc-consent a{color:#7fb2ff;text-decoration:none}#lpc-consent a:hover{text-decoration:underline}" +
      "#lpc-consent .lpc-cc-btns{display:flex;gap:8px;flex-shrink:0}" +
      "#lpc-consent button{font:inherit;font-weight:600;border-radius:8px;padding:9px 16px;cursor:pointer;border:1px solid transparent}" +
      "#lpc-consent .lpc-cc-accept{background:#3b82f6;color:#fff}" +
      "#lpc-consent .lpc-cc-accept:hover{background:#2f6fe0}" +
      "#lpc-consent .lpc-cc-decline{background:transparent;color:#c9d4de;border-color:#2a3644}" +
      "#lpc-consent .lpc-cc-decline:hover{border-color:#4a5a6a;color:#e6edf3}" +
      "@media(prefers-reduced-motion:reduce){#lpc-consent{animation:none}}";
    var st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);

    var bar = document.createElement("div");
    bar.id = "lpc-consent";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", "Cookie consent");
    bar.innerHTML =
      '<p>We use cookies to measure site traffic and improve the experience. ' +
      'Analytics stay off until you accept. <a href="/privacy.html">Learn more</a></p>' +
      '<div class="lpc-cc-btns">' +
      '<button type="button" class="lpc-cc-decline">Decline</button>' +
      '<button type="button" class="lpc-cc-accept">Accept</button></div>';
    document.body.appendChild(bar);

    function choose(v) {
      try { localStorage.setItem(KEY, v); } catch (e) {}
      if (v === "granted") grant();
      bar.remove();
    }
    bar.querySelector(".lpc-cc-accept").addEventListener("click", function () { choose("granted"); });
    bar.querySelector(".lpc-cc-decline").addEventListener("click", function () { choose("denied"); });
  }

  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build);
})();
