/* ============================================================
 * Onboarding — the SPECIFICATION template (the "software spec" checklist).
 *
 * This is the heart of the intake: a structured, per-product set of page
 * sections, integrations, brand/design choices and package options. The wizard
 * renders these; the client's answers are stored in onb_intakes.{brand,spec,…}.
 *
 * Every design/spec item supports a "let the designer decide" opt-out
 * (dev_decides) so a client is never blocked by a question they don't have an
 * opinion on — Daniel fills the gap.
 * ============================================================ */

/* Shared brand/design vocabulary (section 2 of the wizard). Each option group
 * renders as a choice + an optional "let the designer decide" toggle. */
export const DESIGN = {
  layout: {
    label: "Overall layout style",
    help: "The general feel of the page.",
    options: [
      ["minimal", "Minimal & clean", "Lots of whitespace, few elements"],
      ["bold", "Bold & modern", "Big type, strong color, high contrast"],
      ["editorial", "Editorial", "Magazine-like, image-led, elegant"],
      ["playful", "Warm & playful", "Friendly, rounded, approachable"],
      ["corporate", "Professional / corporate", "Structured, trustworthy, classic"],
      ["luxury", "Premium / luxury", "Dark, refined, lots of space"],
    ],
  },
  color_mood: {
    label: "Color mood",
    help: "The emotional tone of the palette.",
    options: [
      ["earthy", "Earthy & natural", "Greens, browns, warm neutrals"],
      ["cool", "Cool & calm", "Blues, teals, greys"],
      ["warm", "Warm & energetic", "Reds, oranges, ambers"],
      ["mono", "Monochrome", "Black / white / one accent"],
      ["vibrant", "Vibrant & colorful", "Multiple bright colors"],
      ["pastel", "Soft & pastel", "Muted, light tones"],
    ],
  },
  typography: {
    label: "Typography vibe",
    options: [
      ["modern_sans", "Modern sans-serif", "Clean, geometric"],
      ["classic_serif", "Classic serif", "Traditional, trustworthy"],
      ["mixed", "Serif headings + sans body", "Editorial contrast"],
      ["handmade", "Handmade / script accents", "Personal, crafted"],
    ],
  },
  imagery: {
    label: "Imagery style",
    options: [
      ["real_photos", "Real photos of your work", "Authentic, specific"],
      ["lifestyle", "Lifestyle / in-context", "People using / enjoying it"],
      ["illustration", "Illustration / graphics", "Custom drawn elements"],
      ["stock", "Polished stock imagery", "Clean, generic-but-nice"],
      ["minimal_img", "Very few images", "Type & color led"],
    ],
  },
  motion: {
    label: "Animation & motion",
    options: [
      ["subtle", "Subtle & tasteful", "Gentle fades on scroll"],
      ["lively", "Lively", "Noticeable, energetic movement"],
      ["none", "None / static", "Fastest, most accessible"],
    ],
  },
  theme: {
    label: "Light or dark",
    options: [
      ["light", "Light background", ""],
      ["dark", "Dark background", ""],
      ["either", "Whatever suits the brand", ""],
    ],
  },
};

/* Page sections offered in the spec builder (section 3). `default_include`
 * pre-checks the common ones. Each becomes an item with include / dev_decides /
 * notes in onb_intakes.spec.sections[key]. */
const COMMON_SECTIONS = [
  ["hero", "Hero / header", "The first thing visitors see — headline, key image, main call-to-action.", true],
  ["about", "About", "Your story, who you are, why you're trusted.", true],
  ["services", "Services / offerings", "What you do, listed clearly.", true],
  ["gallery", "Gallery / portfolio", "Photos of your work or products.", true],
  ["testimonials", "Testimonials / reviews", "Social proof from happy customers.", true],
  ["pricing", "Pricing / packages", "Plans, tiers, or price ranges.", false],
  ["faq", "FAQ", "Answers to the questions you're always asked.", false],
  ["team", "Team / about the owner", "Faces and bios.", false],
  ["contact", "Contact", "How to reach you — form, phone, email, map.", true],
  ["footer", "Footer", "Links, hours, social, legal.", true],
];

const PRODUCT_SECTIONS = {
  desmit: [
    ["process", "How it works / process", "Your steps from inquiry to delivery.", false],
    ["blog", "Blog / news", "Articles or updates.", false],
  ],
  groundwork: [
    ["booking", "Online booking / scheduling", "Let customers book a time themselves.", false],
    ["service_area", "Service area", "Towns / radius you cover, with a map.", false],
  ],
};

/* Integrations / functionality (section 3, part 2). */
const COMMON_INTEGRATIONS = [
  ["contact_form", "Contact form", "Sends inquiries straight to your inbox.", true],
  ["online_booking", "Online booking / calendar", "Customers pick a slot; syncs to your calendar.", false],
  ["payments", "Take payments / deposits online", "Card payments or deposits on the site.", false],
  ["reviews", "Review collection", "Ask happy customers for a Google review.", false],
  ["newsletter", "Newsletter signup", "Grow an email list.", false],
  ["ai_receptionist", "AI receptionist / chat", "Answers questions & captures leads 24/7.", false],
  ["maps", "Map / directions", "Embedded map to your location.", false],
  ["social", "Social media links / feed", "Link or show Instagram / Facebook.", true],
  ["analytics", "Analytics", "See how many people visit (privacy-first).", true],
];

/* Packages + care plans (section 4). Prices are indicative; the deposit &
 * recurring amount are confirmed server-side at checkout. */
export const PACKAGES = [
  ["starter", "Starter", "One-page site + a claimed & optimized Google Business Profile + a review link. Get online, findable & legit. Delivery 3–5 business days.", "from $750"],
  ["foundation", "Foundation", "Everything in Starter, plus online payments, branded invoicing & automatic review requests. Get paid and put reviews on autopilot. Delivery 1–2 weeks.", "from $1,500"],
  ["growth", "Growth", "Everything in Foundation, plus online booking, an AI receptionist + missed-call text-back, accounting sync & the automations that connect it all. (An integration-only, no-AI version is available.) Delivery 2–4 weeks.", "from $3,500"],
  ["full_build", "Full Build", "Everything in Growth, plus a full CRM / field-service system, custom integrations, data migration & staff training — scoped from a discovery workshop. Delivery 4–8 weeks.", "from $6,000"],
  ["custom", "Not sure yet", "We'll scope it together on a free call and recommend the right rung.", "—"],
];

export const CARE_PLANS = [
  ["none", "No care plan", "One-time build — you host & maintain it yourself. (Every build normally lands on a plan so it stays fast, current & monitored.)", 0],
  ["essential", "Essential — maintainer", "Hosting, updates, backups, monitoring & minor monthly changes, plus a plain-English monthly report.", 99],
  ["growth", "Growth — active operator", "Everything in Essential, plus AI receptionist & lead-flow tending, review-automation management, quarterly automation work & priority support.", 300],
  ["partner", "Partner — digital-ops partner", "Fractional digital-ops partner for higher-volume operations: ongoing integration & automation work, first-call priority & a defined SLA.", null],
];

/* ---------- live estimate (indicative, NOT a fixed cart) ----------
 * The tier is the anchor; toggled items nudge a RANGE. These numbers are
 * deliberately soft — the studio always confirms the real quote (quote-first).
 * Tune here. Base ranges start at each tier's floor ("from $X" in the manuals). */
export const PACKAGE_BASE = {
  starter: [750, 1200], foundation: [1500, 2800], growth: [3500, 6000],
  full_build: [6000, 12000], custom: null, // custom → scoped on a call
};
// Incremental add-on ranges (the extra customization cost, on top of the tier
// base — kept modest so the base carries the bulk and we don't double-count).
export const ADDON = {
  integrations: {
    contact_form: [0, 0], online_booking: [150, 400], payments: [150, 400],
    reviews: [100, 250], newsletter: [75, 200], ai_receptionist: [300, 800],
    maps: [0, 50], social: [0, 50], analytics: [0, 50],
  },
  sections: {
    // base sections (hero/about/services/contact/footer) are 0 — included in every tier
    gallery: [75, 200], testimonials: [50, 150], pricing: [75, 200],
    team: [50, 150], faq: [50, 150], blog: [150, 400], process: [75, 200],
    booking: [150, 400], service_area: [50, 150],
  },
};

/* Compute an indicative estimate from the current intake selections. */
export function estimate(intake) {
  const spec = intake.spec || {};
  const add = [0, 0];
  const bump = (rng) => { if (rng) { add[0] += rng[0]; add[1] += rng[1]; } };
  for (const [k, r] of Object.entries(ADDON.integrations)) {
    const c = (spec.integrations || {})[k] || {};
    if (c.include || c.dev_decides) bump(r);
  }
  for (const [k, r] of Object.entries(ADDON.sections)) {
    const c = (spec.sections || {})[k] || {};
    if (c.include || c.dev_decides) bump(r);
  }
  const base = PACKAGE_BASE[intake.package] || null; // null = custom / not chosen
  const care = { essential: 99, growth: 300 }[intake.care_plan] || 0;
  const annual = intake.billing_cycle === "annual";
  return {
    base,
    addons: add,
    total: base ? [base[0] + add[0], base[1] + add[1]] : null,
    care, careAnnual: annual ? care * 10 : null,
    custom: intake.package === "custom" || !intake.package,
  };
}

/* Assemble the per-product spec model the wizard consumes. */
export function specModel(product) {
  const p = product === "groundwork" ? "groundwork" : "desmit";
  const sections = [...COMMON_SECTIONS, ...(PRODUCT_SECTIONS[p] || [])];
  return {
    product: p,
    design: DESIGN,
    sections: sections.map(([key, label, help, def]) => ({ key, label, help, default_include: def })),
    integrations: COMMON_INTEGRATIONS.map(([key, label, help, def]) => ({ key, label, help, default_include: def })),
    packages: PACKAGES,
    care_plans: CARE_PLANS,
  };
}

/* A fresh spec object (used when starting a new intake). */
export function blankSpec(product) {
  const m = specModel(product);
  const sections = {};
  m.sections.forEach((s) => (sections[s.key] = { include: s.default_include, dev_decides: false, notes: "" }));
  const integrations = {};
  m.integrations.forEach((s) => (integrations[s.key] = { include: s.default_include, dev_decides: false, notes: "" }));
  return { sections, integrations, goals: "", must_haves: "", avoid: "", pages_estimate: "", inspiration: "" };
}
