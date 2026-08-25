/* ============================================================
 * Onboarding wizard — engine.
 * Shared by the DeSmit Designs & Groundwork portals. Requires an existing
 * portal session (same Supabase project); if signed out, sends the client to
 * the relevant portal to sign in first.
 *
 * Flow: business → look → spec → package → review → agreement → payment.
 * A draft autosaves the whole way (onb_save_draft RPC).
 * ============================================================ */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { specModel, blankSpec, PACKAGES, CARE_PLANS, DESIGN } from "./spec-template.js";

const CFG = window.ONB_CONFIG;
const P = CFG.PRODUCT;
const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Only ever emit a hex color into a CSS context. esc() guards HTML but not CSS,
// and brand.colors is arbitrary client jsonb — a raw value could inject a CSS
// declaration (e.g. an external url()). Anything not a plain hex → neutral.
const cssColor = (c) => /^#[0-9a-fA-F]{3,8}$/.test(String(c == null ? "" : c).trim())
  ? String(c).trim() : "transparent";

/* ---------- state ---------- */
let user = null;
let intake = null;          // the onb_intakes row
let assets = [];            // onb_assets rows (+ .url signed)
let stepIndex = 0;
const MODEL = specModel(P.key);

const STEPS = [
  { key: "business", title: "About your business", sub: "The basics so we know who we're building for.", render: renderBusiness },
  { key: "look", title: "Your look", sub: "Upload what you have and tell us the vibe. Not sure on something? Tap “let the designer decide.”", render: renderLook },
  { key: "spec", title: "Your page — the spec", sub: "Pick the sections and features you want. This becomes your build specification.", render: renderSpec },
  { key: "package", title: "Package & billing", sub: "Choose your build and (optionally) an ongoing care plan.", render: renderPackage },
  { key: "review", title: "Review your brief", sub: "Here's everything, as a spec document. Print or save a copy if you like.", render: renderReview },
  { key: "agreement", title: "Agreement", sub: "A plain-language services agreement built from your choices.", render: renderAgreement },
  { key: "payment", title: "Deposit & care plan", sub: "Secure your spot. Card handled by Stripe — we never see the number.", render: renderPayment },
];

/* ---------- boot ---------- */
document.documentElement.setAttribute("data-product", P.key);
$("brand-name").textContent = P.name;
$("brand-logo").src = P.logo;
$("brand-logo").onerror = () => { $("brand-logo").style.display = "none"; };

(async function boot() {
  const { data } = await sb.auth.getSession();
  if (!data.session || !data.session.user) return needSignIn();
  user = data.session.user;
  $("who").textContent = user.email;
  await loadOrCreateIntake();
  // Returned from Stripe? The webhook that flips pay_status can lag a moment —
  // poll briefly so the client lands on the confirmed "you're all set" screen.
  if (new URLSearchParams(location.search).get("paid") && intake.pay_status === "unpaid") {
    await confirmPayment();
  }
  subscribeIntake();
  goStep(firstUnfinishedStep());
})();

// Live-update when the studio approves the brief or a payment lands, so a client
// waiting on the "pending review" screen advances without refreshing. Guarded to
// the real transitions (accepted / paid) so our own autosave echoes don't disrupt
// someone mid-edit.
let intakeChannel = null;
function subscribeIntake() {
  if (intakeChannel || !intake) return;
  intakeChannel = sb.channel("onb-intake-" + intake.id)
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "onb_intakes", filter: "id=eq." + intake.id },
      (payload) => {
        const n = payload.new;
        const prevStatus = intake.status, prevPay = intake.pay_status;
        // Adopt ONLY the studio-controlled fields — never the content jsonb
        // (brand/spec/about) the client may be editing right now, or we'd clobber
        // an in-flight edit with our own autosave echo.
        intake.status = n.status;
        intake.pay_status = n.pay_status;
        intake.sign_status = n.sign_status;
        intake.deposit_amount = n.deposit_amount;
        intake.stripe_subscription_id = n.stripe_subscription_id;
        const becameAccepted = prevStatus !== "accepted" && intake.status === "accepted";
        const becameDeclined = prevStatus !== "declined" && intake.status === "declined";
        const becamePaid = prevPay === "unpaid" && (intake.pay_status === "deposit_paid" || intake.pay_status === "active");
        if (becameAccepted || becamePaid || becameDeclined) {
          if (stepIndex >= 4) goStep(firstUnfinishedStep());           // waiting → advance
          else if (becameAccepted) toast("Approved! Head to Review to sign & pay.", "ok");
        }
      })
    .subscribe();
}

async function confirmPayment() {
  showView("view-loading");
  for (let i = 0; i < 8 && intake.pay_status === "unpaid"; i++) {
    await new Promise((r) => setTimeout(r, 1800));
    const { data } = await sb.from("onb_intakes").select("*").eq("id", intake.id).single();
    if (data) intake = Object.assign(intake, data);
  }
}

function needSignIn() {
  showView("view-auth");
  $("auth-portal").href = P.portal;
  $("auth-portal").textContent = `Go to the ${P.name} portal →`;
}

async function loadOrCreateIntake() {
  showView("view-loading");
  // most recent live intake for this product (a declined one is closed; an
  // accepted one must still load so the client can sign & pay).
  const { data } = await sb.from("onb_intakes")
    .select("*")
    .eq("owner_id", user.id).eq("product", P.key)
    .neq("status", "declined")
    .order("updated_at", { ascending: false }).limit(1);
  if (data && data.length) {
    intake = data[0];
  } else {
    const { data: id, error } = await sb.rpc("onb_save_draft", { p_intake: null, p_product: P.key, p_patch: {} });
    if (error) { showView("view-auth"); $("auth-hint").textContent = "Couldn't start your brief — please refresh."; return; }
    const { data: row } = await sb.from("onb_intakes").select("*").eq("id", id).single();
    intake = row;
  }
  if (!intake.spec || !intake.spec.sections) intake.spec = blankSpec(P.key);
  if (!intake.brand) intake.brand = {};
  await loadAssets();
}

async function loadAssets() {
  const { data } = await sb.from("onb_assets").select("*").eq("intake_id", intake.id).order("created_at");
  assets = data || [];
  await Promise.all(assets.map(async (a) => {
    if ((a.mime || "").startsWith("image/") && a.mime !== "image/svg+xml") {
      const { data: s } = await sb.storage.from(CFG.STORAGE_BUCKET).createSignedUrl(a.storage_path, 3600);
      a.url = s ? s.signedUrl : null;
    }
  }));
}

/* ---------- autosave ---------- */
let saveTimer = null, saving = false;
function queueSave() {
  $("save-flag").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 700);
}
async function saveDraft() {
  if (saving || !intake) return;
  saving = true;
  const patch = {
    business_name: intake.business_name, business_description: intake.business_description,
    industry: intake.industry, contact_name: intake.contact_name,
    contact_email: intake.contact_email, contact_phone: intake.contact_phone,
    about: intake.about || {}, brand: intake.brand || {}, spec: intake.spec || {},
    package: intake.package, care_plan: intake.care_plan,
    billing_cycle: intake.billing_cycle, billing: intake.billing || {},
  };
  const { error } = await sb.rpc("onb_save_draft", { p_intake: intake.id, p_product: P.key, p_patch: patch });
  saving = false;
  $("save-flag").textContent = error ? "Not saved — check connection" : "Saved";
}

/* ---------- step routing ---------- */
const isAccepted = () => intake.status === "accepted";
function firstUnfinishedStep() {
  if (intake.pay_status === "deposit_paid" || intake.pay_status === "active") return 6;
  if (intake.sign_status === "signed") return 6;
  if (isAccepted()) return 5;                                    // approved → sign & pay
  if (intake.status === "submitted" || intake.status === "in_review") return 4; // waiting on review
  return 0;
}
function goStep(i) {
  stepIndex = Math.max(0, Math.min(STEPS.length - 1, i));
  const s = STEPS[stepIndex];
  showView("view-wizard");
  renderStepper();
  $("step-title").textContent = s.title;
  $("step-sub").textContent = s.sub;
  $("step-body").innerHTML = "";
  s.render($("step-body"));
  renderNav();
  window.scrollTo({ top: 0 });
}
function renderStepper() {
  $("stepper").innerHTML = STEPS.map((s, i) =>
    `<div class="step ${i < stepIndex ? "done" : ""} ${i === stepIndex ? "active" : ""}">${i + 1}. ${s.key}</div>`).join("");
}
function renderNav() {
  const key = STEPS[stepIndex].key;
  const last = stepIndex === STEPS.length - 1;
  const isReview = key === "review";
  // Quote-first gate: the brief is submitted for review at the end of Review;
  // the agreement + payment steps only advance once the studio marks the intake
  // ACCEPTED. So: on Review, show "Submit" (draft) or "Continue" (accepted), and
  // nothing while it's under review. On Agreement, advance only once signed.
  let showNext = !last;
  let nextLabel = "Continue";
  if (isReview) {
    if (intake.status === "draft") nextLabel = "Submit brief for review";
    else if (isAccepted()) nextLabel = "Looks good — continue";
    else showNext = false; // submitted / in_review → waiting
  }
  if (key === "agreement") showNext = isAccepted() && intake.sign_status === "signed";
  $("nav").innerHTML =
    (stepIndex > 0 ? `<button class="btn btn-ghost" id="nav-back">← Back</button>` : "") +
    `<div class="spacer"></div>` +
    (isReview ? `<button class="btn btn-ghost" id="nav-print">Print / save PDF</button>` : "") +
    (showNext ? `<button class="btn btn-primary" id="nav-next">${nextLabel} →</button>` : "");
  if ($("nav-back")) $("nav-back").onclick = () => { saveDraft(); goStep(stepIndex - 1); };
  if ($("nav-next")) $("nav-next").onclick = onNext;
  if ($("nav-print")) $("nav-print").onclick = () => window.print();
}
async function onNext() {
  await saveDraft();
  const key = STEPS[stepIndex].key;
  if (key === "review") {
    // Submit the brief for the studio to quote. Stay on Review so the client
    // sees the "we're reviewing" banner; sign & pay unlock once accepted.
    if (intake.status === "draft") {
      const { error } = await sb.from("onb_intakes").update({ status: "submitted" }).eq("id", intake.id);
      if (error) { toast("Couldn't submit — try again.", "err"); return; }
      intake.status = "submitted";
      notifyStudio(); // best-effort email to the studio; never blocks submit
      toast("Brief submitted — we'll send your quote shortly.", "ok");
      goStep(stepIndex); // re-render Review with the pending banner
      return;
    }
    if (!isAccepted()) return; // still under review
  }
  goStep(stepIndex + 1);
}

// Tell the studio a brief was submitted (so they know to quote it). Best-effort:
// any failure is swallowed — the submit itself already succeeded server-side.
async function notifyStudio() {
  if (!CFG.NOTIFY_FN) return;
  try {
    const { data: sess } = await sb.auth.getSession();
    if (!sess || !sess.session) return;
    await fetch(CFG.NOTIFY_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + sess.session.access_token },
      body: JSON.stringify({ intake_id: intake.id }),
    });
  } catch (_) { /* ignore */ }
}

/* ============================================================
 * STEP 1 — business
 * ============================================================ */
function renderBusiness(root) {
  root.innerHTML = `
    <div class="card">
      <div class="grid2">
        <div class="field"><label>Business name</label><input type="text" id="f-bn" value="${esc(intake.business_name)}" placeholder="e.g. Lost Pines Landscaping"></div>
        <div class="field"><label>Industry</label><input type="text" id="f-ind" value="${esc(intake.industry)}" placeholder="e.g. Landscaping, Salon, Coffee shop"></div>
      </div>
      <div class="field"><label>What you do <span class="hint" style="display:inline">— a sentence or two</span></label>
        <textarea id="f-desc" placeholder="Tell us about your business in your own words…">${esc(intake.business_description)}</textarea></div>
      <div class="grid2">
        <div class="field"><label>Main contact</label><input type="text" id="f-cn" value="${esc(intake.contact_name)}" placeholder="Your name"></div>
        <div class="field"><label>Contact email</label><input type="email" id="f-ce" value="${esc(intake.contact_email || user.email)}" placeholder="you@email.com"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Phone</label><input type="tel" id="f-cp" value="${esc(intake.contact_phone)}" placeholder="(512) 555-0142"></div>
        <div class="field"><label>Service area <span class="hint" style="display:inline">— towns / radius</span></label><input type="text" id="f-area" value="${esc((intake.about || {}).service_area)}" placeholder="e.g. Bastrop + 30 mi"></div>
      </div>
      <div class="field"><label>Current website / social (if any)</label><input type="url" id="f-web" value="${esc((intake.about || {}).current_web)}" placeholder="https://…"></div>
    </div>`;
  bind("f-bn", (v) => (intake.business_name = v));
  bind("f-ind", (v) => (intake.industry = v));
  bind("f-desc", (v) => (intake.business_description = v));
  bind("f-cn", (v) => (intake.contact_name = v));
  bind("f-ce", (v) => (intake.contact_email = v));
  bind("f-cp", (v) => (intake.contact_phone = v));
  bindAbout("f-area", "service_area");
  bindAbout("f-web", "current_web");
}

/* ============================================================
 * STEP 2 — look (uploads + brand/design choices)
 * ============================================================ */
function renderLook(root) {
  const b = intake.brand;
  root.innerHTML = `
    <div class="card">
      <div class="field"><label>Upload your logo, photos & inspiration</label>
        <p class="hint">Logo, photos of your work/space/team, and any sites or images you like the look of. PNG, JPG, WEBP, SVG or PDF, up to 15 MB each.</p>
        <div class="field" style="margin-bottom:10px">
          <label style="font-size:.82rem">What kind of upload is this?</label>
          <div class="chips" id="upl-kind">
            <div class="chip sel" data-kind="logo">Logo</div>
            <div class="chip" data-kind="photo">Photo of my work</div>
            <div class="chip" data-kind="inspiration">Inspiration</div>
          </div>
        </div>
        <div class="uploader" id="uploader">
          <p>Drop files here, or <b>click to choose</b></p>
          <div class="sub">You can also add these later.</div>
          <input type="file" id="file-input" accept="image/*,application/pdf" multiple hidden>
        </div>
        <div class="thumbs" id="thumbs"></div>
      </div>
    </div>
    <div class="card">
      <div class="field"><label>Brand colors</label>
        <p class="hint">Add any colors you already use (or want). Skip if you're not sure.</p>
        <div class="colors" id="colors"></div>
      </div>
      <div class="field"><label>Tagline / slogan (optional)</label><input type="text" id="f-tag" value="${esc(b.tagline)}" placeholder="e.g. Rooted in quality."></div>
      <div id="design-groups"></div>
    </div>`;

  // uploads
  let curKind = "logo";
  root.querySelectorAll("#upl-kind .chip").forEach((c) => c.onclick = () => {
    root.querySelectorAll("#upl-kind .chip").forEach((x) => x.classList.remove("sel"));
    c.classList.add("sel"); curKind = c.dataset.kind;
  });
  const up = $("uploader"), fi = $("file-input");
  up.onclick = () => fi.click();
  up.ondragover = (e) => { e.preventDefault(); up.classList.add("drag"); };
  up.ondragleave = () => up.classList.remove("drag");
  up.ondrop = (e) => { e.preventDefault(); up.classList.remove("drag"); handleFiles(e.dataTransfer.files, curKind); };
  fi.onchange = () => { handleFiles(fi.files, curKind); fi.value = ""; };
  renderThumbs();

  // colors
  renderColors();
  $("colors").insertAdjacentHTML("beforeend", `<input type="color" id="add-color" style="width:40px;height:34px;padding:0;border:none;background:none;cursor:pointer"><button class="btn btn-ghost btn-sm" id="add-color-btn">+ Add color</button>`);
  $("add-color-btn").onclick = () => {
    const v = $("add-color").value;
    b.colors = b.colors || []; if (!b.colors.includes(v)) b.colors.push(v);
    queueSave(); renderLook(root);
  };

  bind("f-tag", (v) => (b.tagline = v));

  // design choice groups
  const dg = $("design-groups");
  Object.entries(DESIGN).forEach(([key, group]) => {
    const wrap = document.createElement("div"); wrap.className = "opt-group";
    const cur = (b.design || {})[key];
    const devOn = ((b.design_dev || {})[key]) ? "sel" : "";
    wrap.innerHTML = `<div class="lbl">${esc(group.label)}</div>` +
      (group.help ? `<div class="help">${esc(group.help)}</div>` : "") +
      `<div class="chips">` +
      group.options.map(([val, lab, sub]) =>
        `<div class="chip ${cur === val ? "sel" : ""}" data-k="${key}" data-v="${val}">${esc(lab)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>`).join("") +
      `<div class="chip dev ${devOn}" data-dev="${key}">🎨 Let the designer decide</div>` +
      `</div>`;
    dg.appendChild(wrap);
  });
  dg.querySelectorAll(".chip[data-v]").forEach((c) => c.onclick = () => {
    b.design = b.design || {}; b.design[c.dataset.k] = c.dataset.v;
    if (b.design_dev) delete b.design_dev[c.dataset.k];
    queueSave(); renderLook(root);
  });
  dg.querySelectorAll(".chip[data-dev]").forEach((c) => c.onclick = () => {
    b.design_dev = b.design_dev || {}; const k = c.dataset.dev;
    b.design_dev[k] = !b.design_dev[k];
    if (b.design_dev[k] && b.design) delete b.design[k];
    queueSave(); renderLook(root);
  });
}

function renderColors() {
  const b = intake.brand; const box = $("colors"); if (!box) return;
  box.innerHTML = (b.colors || []).map((c, i) =>
    `<span class="color-pill"><span class="sw" style="background:${cssColor(c)}"></span>${esc(c)}<button data-rm="${i}">×</button></span>`).join("");
  box.querySelectorAll("[data-rm]").forEach((btn) => btn.onclick = () => {
    b.colors.splice(+btn.dataset.rm, 1); queueSave(); renderLook(document.getElementById("step-body"));
  });
}

function renderThumbs() {
  const box = $("thumbs"); if (!box) return;
  box.innerHTML = assets.map((a) => {
    const isImg = a.url && (a.mime || "").startsWith("image/") && a.mime !== "image/svg+xml";
    return `<div class="thumb ${isImg ? "" : "pdf"}" data-id="${a.id}">` +
      (isImg ? `<img src="${a.url}" alt="">` : `<span>${esc(a.filename || "file")}</span>`) +
      `<button class="rm" data-rm="${a.id}" title="Remove">×</button>` +
      `<span class="kind">${esc(a.kind)}</span></div>`;
  }).join("");
  box.querySelectorAll("[data-rm]").forEach((btn) => btn.onclick = () => removeAsset(btn.dataset.rm));
}

async function handleFiles(fileList, kind) {
  const files = Array.from(fileList).slice(0, 12);
  for (const f of files) {
    if (f.size > 15 * 1024 * 1024) { toast(`${f.name} is over 15 MB — skipped.`, "err"); continue; }
    const safe = f.name.replace(/[^\w.\-]+/g, "_").slice(-60);
    const path = `${user.id}/${intake.id}/${crypto.randomUUID()}-${safe}`;
    const { error } = await sb.storage.from(CFG.STORAGE_BUCKET).upload(path, f, { contentType: f.type, upsert: false });
    if (error) { toast(`Couldn't upload ${f.name}.`, "err"); continue; }
    const { data: row } = await sb.from("onb_assets").insert({
      intake_id: intake.id, owner_id: user.id, kind, storage_path: path,
      filename: f.name, mime: f.type, size_bytes: f.size,
    }).select("*").single();
    if (row) {
      if ((row.mime || "").startsWith("image/") && row.mime !== "image/svg+xml") {
        const { data: s } = await sb.storage.from(CFG.STORAGE_BUCKET).createSignedUrl(path, 3600);
        row.url = s ? s.signedUrl : null;
      }
      assets.push(row);
    }
  }
  renderThumbs();
  toast("Uploaded.", "ok");
}

async function removeAsset(id) {
  const a = assets.find((x) => x.id === id); if (!a) return;
  await sb.storage.from(CFG.STORAGE_BUCKET).remove([a.storage_path]);
  await sb.from("onb_assets").delete().eq("id", id);
  assets = assets.filter((x) => x.id !== id);
  renderThumbs();
}

/* ============================================================
 * STEP 3 — spec builder
 * ============================================================ */
function renderSpec(root) {
  const spec = intake.spec;
  const itemRow = (col, item, chosen) => {
    const inc = chosen.include && !chosen.dev_decides;
    return `<div class="spec-item ${!chosen.include && !chosen.dev_decides ? "off" : ""}" data-col="${col}" data-key="${item.key}">
      <div class="top"><div class="txt"><b>${esc(item.label)}</b><p>${esc(item.help)}</p></div>
        <div class="toggles">
          <div class="tgl ${inc ? "on" : ""}" data-act="include">Include</div>
          <div class="tgl dev ${chosen.dev_decides ? "on" : ""}" data-act="dev">Dev decides</div>
        </div></div>
      <div class="note-wrap" ${chosen.include && !chosen.dev_decides ? "" : 'style="display:none"'}>
        <textarea placeholder="Anything specific for this? (optional)">${esc(chosen.notes)}</textarea>
      </div></div>`;
  };
  root.innerHTML = `
    <div class="card">
      <h3 style="font-family:'Rajdhani';margin-bottom:6px">Page sections</h3>
      <p class="hint" style="margin-bottom:14px">Toggle what you want on the page. Not sure? Hit <b>Dev decides</b> and we'll recommend.</p>
      <div id="sec-list">${MODEL.sections.map((s) => itemRow("sections", s, spec.sections[s.key] || {})).join("")}</div>
    </div>
    <div class="card">
      <h3 style="font-family:'Rajdhani';margin-bottom:6px">Features & integrations</h3>
      <p class="hint" style="margin-bottom:14px">Functionality to connect.</p>
      <div id="int-list">${MODEL.integrations.map((s) => itemRow("integrations", s, spec.integrations[s.key] || {})).join("")}</div>
    </div>
    <div class="card">
      <div class="field"><label>What should this page achieve? <span class="hint" style="display:inline">— your #1 goal</span></label>
        <textarea id="f-goals" placeholder="e.g. Get more booked jobs / calls / online orders.">${esc(spec.goals)}</textarea></div>
      <div class="field"><label>Must-haves</label><textarea id="f-must" placeholder="Anything that absolutely has to be there.">${esc(spec.must_haves)}</textarea></div>
      <div class="field"><label>Please avoid</label><textarea id="f-avoid" placeholder="Colors, styles, or things you dislike.">${esc(spec.avoid)}</textarea></div>
      <div class="field"><label>Sites you like the look of</label><textarea id="f-insp" placeholder="Paste a few links and what you like about each.">${esc(spec.inspiration)}</textarea></div>
    </div>`;

  root.querySelectorAll(".spec-item").forEach((el) => {
    const col = el.dataset.col, key = el.dataset.key;
    const obj = spec[col][key] || (spec[col][key] = { include: false, dev_decides: false, notes: "" });
    el.querySelector('[data-act="include"]').onclick = () => {
      obj.include = !obj.include; if (obj.include) obj.dev_decides = false; queueSave(); renderSpec(root);
    };
    el.querySelector('[data-act="dev"]').onclick = () => {
      obj.dev_decides = !obj.dev_decides; if (obj.dev_decides) obj.include = false; queueSave(); renderSpec(root);
    };
    const ta = el.querySelector("textarea");
    if (ta) ta.oninput = () => { obj.notes = ta.value; queueSave(); };
  });
  bindSpec("f-goals", "goals"); bindSpec("f-must", "must_haves");
  bindSpec("f-avoid", "avoid"); bindSpec("f-insp", "inspiration");
}

/* ============================================================
 * STEP 4 — package & billing
 * ============================================================ */
function renderPackage(root) {
  const cyc = intake.billing_cycle || "monthly";
  root.innerHTML = `
    <div class="card">
      <div class="opt-group"><div class="lbl">Which build fits?</div>
        <div class="chips">${PACKAGES.map(([v, lab, sub, price]) =>
          `<div class="chip ${intake.package === v ? "sel" : ""}" data-pkg="${v}"><b>${esc(lab)}</b> · ${esc(price)}<small>${esc(sub)}</small></div>`).join("")}</div>
      </div>
    </div>
    <div class="card">
      <div class="opt-group"><div class="lbl">Ongoing care plan</div>
        <div class="help">Optional. Hosting, updates, backups & monitoring so it stays fast and current. Cancel anytime.</div>
        <div class="chips">${CARE_PLANS.map(([v, lab, sub, amt]) =>
          `<div class="chip ${intake.care_plan === v ? "sel" : ""}" data-care="${v}"><b>${esc(lab)}</b>${amt ? ` · $${amt}/mo` : (v === "partner" ? " · custom" : "")}<small>${esc(sub)}</small></div>`).join("")}</div>
      </div>
      <div class="opt-group" id="cycle-group" ${["essential", "growth"].includes(intake.care_plan) ? "" : 'style="display:none"'}>
        <div class="lbl">Billing cycle</div>
        <div class="chips">
          <div class="chip ${cyc === "monthly" ? "sel" : ""}" data-cyc="monthly">Monthly</div>
          <div class="chip ${cyc === "annual" ? "sel" : ""}" data-cyc="annual">Annual <small>2 months free</small></div>
        </div>
      </div>
    </div>
    <div class="banner warn">Final amounts (any custom quote / deposit) are confirmed by ${esc(P.name)} before anything is charged. You'll approve the exact numbers on the payment step.</div>`;

  root.querySelectorAll("[data-pkg]").forEach((c) => c.onclick = () => { intake.package = c.dataset.pkg; queueSave(); renderPackage(root); });
  root.querySelectorAll("[data-care]").forEach((c) => c.onclick = () => { intake.care_plan = c.dataset.care; queueSave(); renderPackage(root); });
  root.querySelectorAll("[data-cyc]").forEach((c) => c.onclick = () => { intake.billing_cycle = c.dataset.cyc; queueSave(); renderPackage(root); });
}

/* ============================================================
 * STEP 5 — review (the spec document)
 * ============================================================ */
function renderReview(root) {
  let banner = "";
  if (intake.status === "draft") {
    banner = `<div class="banner">Here's your brief. When it looks right, hit <b>Submit brief for review</b> below — ${esc(P.name)} will confirm the scope and send your quote, then your agreement &amp; deposit unlock here.</div>`;
  } else if (intake.status === "submitted" || intake.status === "in_review") {
    banner = `<div class="banner warn">✓ Submitted — ${esc(P.name)} is reviewing your brief and preparing your quote. We'll email you; your agreement &amp; deposit will appear here once it's approved. You can still edit above and it'll update your brief.</div>`;
  } else if (isAccepted()) {
    banner = `<div class="banner ok">✓ Approved! Your quote is ready. Continue to sign your agreement and pay your deposit.</div>`;
  }
  root.innerHTML = banner + `<div class="doc" id="doc">${buildDocHtml()}</div>`;
}
function buildDocHtml() {
  const b = intake.brand || {}, spec = intake.spec || {};
  const pkg = (PACKAGES.find((p) => p[0] === intake.package) || [])[1] || "—";
  const care = (CARE_PLANS.find((p) => p[0] === intake.care_plan) || [])[1] || "None";
  const designRows = Object.entries(DESIGN).map(([k, g]) => {
    const dev = (b.design_dev || {})[k];
    const val = (b.design || {})[k];
    const label = dev ? `<span class="tag dev">designer's choice</span>` :
      val ? esc((g.options.find((o) => o[0] === val) || [])[1] || val) : `<span class="tag">—</span>`;
    return `<dt>${esc(g.label)}</dt><dd>${label}</dd>`;
  }).join("");
  const listCol = (col, model) => model.map((s) => {
    const c = (spec[col] || {})[s.key] || {};
    if (c.dev_decides) return `<span class="tag dev">${esc(s.label)} · dev decides</span>`;
    if (c.include) return `<span class="tag">${esc(s.label)}${c.notes ? " ✎" : ""}</span>`;
    return "";
  }).join("");
  const notesCol = (col, model) => model.filter((s) => ((spec[col] || {})[s.key] || {}).notes)
    .map((s) => `<dt>${esc(s.label)}</dt><dd>${esc(spec[col][s.key].notes)}</dd>`).join("");

  return `
    <h3>1 · Business</h3>
    <dl>
      <dt>Business</dt><dd>${esc(intake.business_name) || "—"}</dd>
      <dt>Industry</dt><dd>${esc(intake.industry) || "—"}</dd>
      <dt>What they do</dt><dd>${esc(intake.business_description) || "—"}</dd>
      <dt>Contact</dt><dd>${esc(intake.contact_name)} · ${esc(intake.contact_email)} · ${esc(intake.contact_phone)}</dd>
      <dt>Service area</dt><dd>${esc((intake.about || {}).service_area) || "—"}</dd>
    </dl>
    <h3>2 · Brand & look</h3>
    <dl>
      <dt>Colors</dt><dd>${(b.colors || []).map((c) => `<span class="tag"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${cssColor(c)};margin-right:5px"></span>${esc(c)}</span>`).join("") || "designer's choice"}</dd>
      <dt>Tagline</dt><dd>${esc(b.tagline) || "—"}</dd>
      ${designRows}
    </dl>
    <h3>3 · Uploaded assets</h3>
    <dl><dt>Files</dt><dd>${assets.length ? assets.map((a) => `<span class="tag">${esc(a.kind)}: ${esc(a.filename)}</span>`).join("") : "None yet"}</dd></dl>
    <h3>4 · Page specification</h3>
    <dl>
      <dt>Sections</dt><dd>${listCol("sections", MODEL.sections) || "—"}</dd>
      <dt>Features</dt><dd>${listCol("integrations", MODEL.integrations) || "—"}</dd>
      <dt>Goal</dt><dd>${esc(spec.goals) || "—"}</dd>
      <dt>Must-haves</dt><dd>${esc(spec.must_haves) || "—"}</dd>
      <dt>Avoid</dt><dd>${esc(spec.avoid) || "—"}</dd>
      <dt>Inspiration</dt><dd>${esc(spec.inspiration) || "—"}</dd>
    </dl>
    ${notesCol("sections", MODEL.sections) || notesCol("integrations", MODEL.integrations) ?
      `<h3>Section notes</h3><dl>${notesCol("sections", MODEL.sections)}${notesCol("integrations", MODEL.integrations)}</dl>` : ""}
    <h3>5 · Package & billing</h3>
    <dl>
      <dt>Build</dt><dd>${esc(pkg)}</dd>
      <dt>Care plan</dt><dd>${esc(care)}${["essential", "growth"].includes(intake.care_plan) ? ` · ${esc(intake.billing_cycle || "monthly")}` : ""}</dd>
    </dl>`;
}

/* ============================================================
 * STEP 6 — agreement (e-sign)
 * ============================================================ */
function buildAgreementText() {
  const pkg = (PACKAGES.find((p) => p[0] === intake.package) || [])[1] || "the agreed build";
  const careRow = CARE_PLANS.find((p) => p[0] === intake.care_plan);
  const care = careRow ? careRow[1] : "None";
  const careAmt = careRow && typeof careRow[3] === "number" && careRow[3] > 0 ? careRow[3] : null;
  const cycle = intake.billing_cycle === "annual" ? "annually" : "monthly";
  const careLine = intake.care_plan && intake.care_plan !== "none"
    ? (careAmt
        ? `${care} at $${cycle === "annually" ? careAmt * 10 : careAmt}/${cycle === "annually" ? "yr" : "mo"}, billed ${cycle}`
        : `${care} (billed on an agreed custom retainer)`)
    : "None selected";
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return `SERVICES AGREEMENT — ${P.name} (a studio of Lost Pines Creative LLC)
Version ${CFG.AGREEMENT_VERSION} · Prepared ${today}

CLIENT: ${intake.business_name || intake.contact_name || user.email}
CONTACT: ${intake.contact_name || ""} — ${intake.contact_email || user.email}
STUDIO: Lost Pines Creative LLC (d/b/a ${P.name}), Bastrop, Texas

This agreement is between the Client and the Studio for the project described in
the Client's onboarding brief (the "Spec"), which is incorporated by reference.

1. SCOPE. The Studio will deliver the selected build — ${pkg} — as detailed in the
   Spec. Items the Client marked "let the designer decide" are left to the Studio's
   reasonable professional judgment. Work materially beyond the Spec is a change
   (see §6) and will be quoted separately before it is done.

2. FEES, DEPOSIT & PAYMENT. Work begins after the deposit is received. Unless a
   written quote says otherwise, the deposit is 50% of the project total and is
   applied to that total; the remaining balance is due on delivery/launch. Larger
   or scoped builds (e.g. Full Build) may instead be billed against a written
   milestone schedule. Invoices are due on receipt; balances unpaid 14 days past
   due may pause work. Prices are in U.S. dollars.

3. THIRD-PARTY COSTS — AT COST, NEVER MARKED UP. Domains, hosting, software,
   telephony, AI usage, and any other third-party services are the Client's own
   accounts and are billed to the Client at actual cost with no markup, itemized.
   The Client is responsible for these ongoing costs.

4. OWNERSHIP — YOU OWN EVERYTHING, ALWAYS. Every account created for the project is
   created in the Client's name; the Client owns those accounts and all of their
   data at all times. On full payment for the build, the Client also owns the
   delivered work product. During any active Care plan the Studio holds admin/
   manager access to operate and maintain the systems; on offboarding the Studio
   transfers full ownership, removes its own access, and delivers final exports and
   the "Your System" runbook. No hostage data, no lock-in. The Studio may display
   non-confidential work in its portfolio unless the Client opts out in writing.

5. CARE PLAN (ongoing). Selected plan: ${careLine}. Care plans are recurring and
   continue until cancelled. Either party may cancel with notice, effective at the
   end of the current paid period; the current period is non-refundable. Third-
   party usage under the plan is billed at cost per §3. Plan scope is per the
   published Care tiers; work beyond the tier is quoted as a mini-project.

6. REVISIONS, CLIENT RESPONSIBILITIES & TIMELINE. Reasonable revisions within the
   agreed Spec are included. The Client agrees to provide content, approvals, and
   account access promptly; timelines and delivery dates assume this and shift if
   the Client's inputs are delayed. Substantial new requests are quoted separately.

7. CANCELLATION. Either party may cancel the build with written notice. Fees for
   work completed to the cancellation date are earned and non-refundable, and the
   deposit covers initial work; any unused prepaid amount for work not yet started
   is refunded.

8. WARRANTY & LIABILITY. The Studio provides the services on a commercially
   reasonable-efforts basis and does not guarantee specific business outcomes
   (e.g. rankings, revenue, or call volume). To the extent permitted by law, the
   Studio's total liability under this agreement is limited to the fees the Client
   paid for the build, and neither party is liable for indirect or consequential
   damages. The Client is responsible for the lawful use of any messaging/review-
   request features (including applicable consent/TCPA requirements).

9. INDEPENDENT CONTRACTOR & CONFIDENTIALITY. The Studio is an independent
   contractor, not an employee or partner of the Client. Each party will keep the
   other's non-public information confidential and use it only to perform this
   agreement.

10. ELECTRONIC SIGNATURE. By typing your full legal name and checking the box, you
    agree this constitutes your electronic signature under the U.S. E-SIGN Act,
    that you have authority to bind the Client, and that you have read and accept
    this agreement and the attached Spec.

Governing law: State of Texas. Questions: ${P.email}.`;
}
function renderAgreement(root) {
  if (!isAccepted() && intake.sign_status !== "signed") {
    root.innerHTML = pendingGate("Your agreement");
    return;
  }
  if (intake.sign_status === "signed") {
    root.innerHTML = `<div class="banner ok">Signed by ${esc(intake.signed_name)} on ${new Date(intake.signed_at).toLocaleString()}. A copy was emailed to you.</div>
      <div class="agreement">${esc(intake.agreement_snapshot || buildAgreementText())}</div>`;
    return;
  }
  const text = buildAgreementText();
  root.innerHTML = `
    <div class="card">
      <div class="agreement" id="agr-text">${esc(text)}</div>
      <div class="sign-row"><input type="text" id="sign-name" placeholder="Type your full legal name"></div>
      <label class="agree-check"><input type="checkbox" id="agr-ok">
        <span>I have read and agree to this Services Agreement. Typing my name is my electronic signature.</span></label>
      <div class="error-text" id="sign-err"></div>
      <div style="text-align:right;margin-top:14px">
        <button class="btn btn-primary" id="sign-btn" disabled>Sign &amp; continue →</button>
      </div>
    </div>`;
  const name = $("sign-name"), ok = $("agr-ok"), btn = $("sign-btn");
  const refresh = () => { btn.disabled = !(name.value.trim().length >= 2 && ok.checked); };
  name.oninput = refresh; ok.onchange = refresh;
  btn.onclick = () => signAgreement(text, name.value.trim(), btn);
}
async function signAgreement(text, name, btn) {
  btn.disabled = true; $("sign-err").textContent = "";
  try {
    const { data: sess } = await sb.auth.getSession();
    if (!sess || !sess.session) {
      $("sign-err").textContent = "Your session expired — please sign in again.";
      setTimeout(() => (location.href = P.portal), 1500); return;
    }
    const res = await fetch(CFG.SIGN_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + sess.session.access_token },
      body: JSON.stringify({ intake_id: intake.id, signed_name: name,
        agreement_version: CFG.AGREEMENT_VERSION }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Couldn't record your signature.");
    intake.sign_status = "signed"; intake.signed_name = name;
    intake.signed_at = body.signed_at || new Date().toISOString();
    // the server returns the canonical agreement it actually recorded — show that
    intake.agreement_snapshot = body.agreement_text || text;
    toast("Signed — thank you.", "ok");
    goStep(stepIndex + 1);
  } catch (e) {
    $("sign-err").textContent = e.message; btn.disabled = false;
  }
}

/* ============================================================
 * STEP 7 — payment (Stripe Checkout)
 * ============================================================ */
function renderPayment(root) {
  if (intake.pay_status === "deposit_paid" || intake.pay_status === "active") {
    root.innerHTML = `<div class="banner ok">Payment received — you're all set! ${esc(P.name)} will be in touch to kick off. You can close this page.</div>
      <div class="card"><p class="muted">A receipt was emailed by Stripe. Track your project any time in the <a href="${P.portal}">${esc(P.name)} portal</a>.</p></div>`;
    return;
  }
  if (!isAccepted()) { root.innerHTML = pendingGate("Your deposit"); return; }
  if (intake.sign_status !== "signed") {
    root.innerHTML = `<div class="banner warn">Please sign the agreement first.</div>`;
    return;
  }
  const careAmt = { essential: 99, growth: 300 }[intake.care_plan];
  const annual = intake.billing_cycle === "annual";
  const depositLabel = intake.deposit_amount != null && Number(intake.deposit_amount) > 0
    ? "$" + Number(intake.deposit_amount).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : "confirmed at checkout";
  root.innerHTML = `
    <div class="card">
      <h3 style="font-family:'Rajdhani';margin-bottom:12px">Order summary</h3>
      <div class="pay-line"><span>Project deposit <small class="muted">(applied to your total)</small></span><span class="amt" id="dep-amt">${depositLabel}</span></div>
      ${careAmt ? `<div class="pay-line"><span>${esc((CARE_PLANS.find((c) => c[0] === intake.care_plan) || [])[1])} care · ${annual ? "annual" : "monthly"}</span><span class="amt">$${annual ? careAmt * 10 : careAmt}${annual ? "/yr" : "/mo"}</span></div>` : ""}
      <div class="pay-line total"><span>Due today</span><span class="amt">deposit${careAmt ? " + first period" : ""}</span></div>
      <p class="muted" style="margin-top:14px">You'll enter your card securely on Stripe's checkout, then land back here. The exact deposit amount is set by ${esc(P.name)} on your quote.</p>
      <div class="error-text" id="pay-err"></div>
      <div style="text-align:right;margin-top:12px">
        <button class="btn btn-primary" id="pay-btn">Continue to secure checkout →</button>
      </div>
    </div>
    <p class="muted" style="text-align:center;margin-top:14px">Prefer to arrange payment another way? Email <a href="mailto:${esc(P.email)}">${esc(P.email)}</a>.</p>`;
  $("pay-btn").onclick = () => startCheckout($("pay-btn"));
}
async function startCheckout(btn) {
  btn.disabled = true; $("pay-err").textContent = "";
  try {
    const { data: sess } = await sb.auth.getSession();
    if (!sess || !sess.session) {
      $("pay-err").textContent = "Your session expired — please sign in again.";
      setTimeout(() => (location.href = P.portal), 1500); return;
    }
    const res = await fetch(CFG.CHECKOUT_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + sess.session.access_token },
      body: JSON.stringify({ intake_id: intake.id, return_url: CFG.RETURN_URL }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.url) throw new Error(body.error || "Couldn't start checkout.");
    location.href = body.url;
  } catch (e) {
    $("pay-err").textContent = e.message; btn.disabled = false;
  }
}

/* ---------- helpers ---------- */
// Shown on the Agreement / Payment steps until the studio marks the intake
// accepted (quote-first). "Back" in the nav returns them to their brief.
function pendingGate(what) {
  if (intake.status === "declined") {
    return `<div class="banner warn">This brief has been closed. If that's a surprise, reach out at <a href="mailto:${esc(P.email)}">${esc(P.email)}</a>.</div>`;
  }
  return `<div class="card" style="text-align:center">
    <div style="font-size:2rem;margin-bottom:6px">🕓</div>
    <h3 style="font-family:'Rajdhani';font-size:1.3rem;margin-bottom:8px">${esc(what)} unlocks after review</h3>
    <p class="muted">${esc(P.name)} is confirming your scope and preparing your quote. The moment it's approved you'll be able to sign your agreement and pay your deposit right here — and we'll email you. Use <b>← Back</b> to tweak your brief in the meantime.</p>
  </div>`;
}
function bind(id, set) { const el = $(id); if (!el) return; el.oninput = () => { set(el.value); queueSave(); }; }
function bindAbout(id, key) { const el = $(id); if (!el) return; el.oninput = () => { intake.about = intake.about || {}; intake.about[key] = el.value; queueSave(); }; }
function bindSpec(id, key) { const el = $(id); if (!el) return; el.oninput = () => { intake.spec[key] = el.value; queueSave(); }; }

function showView(id) { document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id)); }
let toastTimer = null;
function toast(msg, kind) {
  const el = $("toast"); if (!el) return;
  el.textContent = msg; el.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = "toast"), 3000);
}
$("signout").onclick = async () => { await sb.auth.signOut(); location.href = P.portal; };
