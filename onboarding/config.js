/* ============================================================
 * Onboarding — shared configuration.
 *
 * ONE onboarding engine serves both portals. The Supabase project is the same
 * as the DeSmit / Groundwork portals (ekogelnbhggyrychfrta); which brand is
 * shown is chosen by ?product=desmit|groundwork on the URL (defaults to desmit).
 *
 * The anon key is safe to ship publicly — Row-Level Security guards all data.
 * ============================================================ */
const SUPABASE_URL = "https://ekogelnbhggyrychfrta.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrb2dlbG5iaGdneXJ5Y2hmcnRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczMjAwNzUsImV4cCI6MjEwMjg5NjA3NX0.0AC8vY8A-oPj-hArn_PY5jPRAGcc2mgfu5SV2wqSxP0";

const PRODUCTS = {
  desmit: {
    key: "desmit",
    name: "DeSmit Designs",
    logo: "/desmitdesigns/images/logo.png",
    portal: "/desmitdesigns/portal/",
    accent: "#3b82f6",
    accent2: "#06b6d4",
    email: "desmitdesignz@gmail.com",
  },
  groundwork: {
    key: "groundwork",
    name: "Groundwork",
    logo: "/groundwork-mark.svg",
    portal: "/groundwork/portal/",
    accent: "#4a9e7e",
    accent2: "#3ba5a1",
    email: "desmitdesignz@gmail.com",
  },
};

// Onboarding is currently a web/local-business intake — it maps to Groundwork.
// DeSmit Designs (fabrication / CAD / laser / 3D print) uses its own portal
// "Request a service" quote flow instead, so Groundwork is the default and the
// only linked product. The engine stays product-parameterized so a dedicated
// DeSmit fabrication-brief template can be added later without rework.
function resolveProduct() {
  const q = new URLSearchParams(location.search).get("product");
  return PRODUCTS[q] ? q : "groundwork";
}

const PRODUCT_KEY = resolveProduct();

window.ONB_CONFIG = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  PRODUCT_KEY,
  PRODUCT: PRODUCTS[PRODUCT_KEY],
  PRODUCTS,
  // Edge functions (deployed against the same project).
  CHECKOUT_FN: `${SUPABASE_URL}/functions/v1/onb-checkout`,
  SIGN_FN: `${SUPABASE_URL}/functions/v1/onb-sign`,
  NOTIFY_FN: `${SUPABASE_URL}/functions/v1/onb-notify`,
  LOOKUP_FN: `${SUPABASE_URL}/functions/v1/onb-lookup`,
  STORAGE_BUCKET: "onboarding",
  // Where Stripe / auth should return the client. Must be an allowed redirect
  // in Supabase Auth ▸ URL Configuration.
  RETURN_URL: `${location.origin}/onboarding/?product=${PRODUCT_KEY}`,
  // Current agreement version — bump when the contract text changes materially.
  AGREEMENT_VERSION: "msa-v1",
};
