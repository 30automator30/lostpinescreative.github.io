/* Lost Pines Creative — shared Google Analytics 4 loader.
 * One place to manage the GA4 tag across the whole lostpinescreative.com
 * property (LPC, Groundwork + demos, DeSmit Designs, portal, admin).
 * Included on each page via <script src="/analytics.js"></script>.
 */
(function () {
  var ID = "G-80VW0JE7HW";
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { dataLayer.push(arguments); };
  gtag("js", new Date());
  gtag("config", ID);
})();
