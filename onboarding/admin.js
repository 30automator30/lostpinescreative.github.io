/* ============================================================
 * Onboarding — admin console (shared, for the studio owner).
 * Lists every intake across both products, shows the full brief + uploaded
 * assets + contract/payment status, and lets the owner set the real deposit
 * amount and move the intake through its status.
 * Admin gate: dd_profiles.is_admin (same flag as the portals).
 * ============================================================ */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { specModel, PACKAGES, CARE_PLANS, DESIGN } from "./spec-template.js";

const CFG = window.ONB_CONFIG;
const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Client brand.colors is arbitrary jsonb; only ever emit a hex value into a CSS
// context, or a crafted color string could inject a CSS declaration (e.g. an
// external url() beacon) into the owner's admin view.
const cssColor = (c) => /^#[0-9a-fA-F]{3,8}$/.test(String(c == null ? "" : c).trim())
  ? String(c).trim() : "transparent";
const fmt = (iso) => iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
const PRODUCT_LABEL = { desmit: "DeSmit Designs", groundwork: "Groundwork" };

let user = null, rows = [];

(async function boot() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return deny("You're not signed in.");
  user = data.session.user;
  $("who").textContent = user.email;
  $("signout").style.display = "";
  const { data: prof } = await sb.from("dd_profiles").select("is_admin").eq("id", user.id).single();
  if (!prof || !prof.is_admin) return deny("This account isn't a studio admin.");
  $("signout").onclick = async () => { await sb.auth.signOut(); location.href = "/desmitdesigns/portal/"; };
  $("f-product").onchange = load; $("f-status").onchange = load;
  $("back").onclick = () => show("view-list");
  await load();
})();

function deny(msg) { show("view-denied"); $("denied-hint").textContent = msg; }
function show(id) { document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id)); window.scrollTo({ top: 0 }); }

async function load() {
  show("view-list");
  $("list-box").innerHTML = '<div class="spinner"></div>';
  let q = sb.from("onb_intakes").select("*").order("updated_at", { ascending: false });
  if ($("f-product").value) q = q.eq("product", $("f-product").value);
  if ($("f-status").value) q = q.eq("status", $("f-status").value);
  const { data, error } = await q;
  if (error) { $("list-box").innerHTML = '<p class="muted">Couldn\'t load intakes.</p>'; return; }
  rows = data || [];
  if (!rows.length) { $("list-box").innerHTML = '<p class="muted">No intakes yet.</p>'; return; }
  $("list-box").innerHTML =
    `<table class="list"><thead><tr><th>Business</th><th>Product</th><th>Package</th><th>Status</th><th>Signed</th><th>Payment</th><th>Updated</th></tr></thead><tbody>` +
    rows.map((r) => `<tr class="click" data-id="${r.id}">
      <td><b>${esc(r.business_name) || "(untitled)"}</b><br><span class="muted">${esc(r.contact_email)}</span></td>
      <td>${esc(PRODUCT_LABEL[r.product] || r.product)}</td>
      <td>${esc(pkgLabel(r.package))}</td>
      <td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
      <td><span class="pill ${esc(r.sign_status)}">${esc(r.sign_status)}</span></td>
      <td><span class="pill ${esc(r.pay_status)}">${esc(r.pay_status.replace("_", " "))}</span></td>
      <td class="muted">${fmt(r.updated_at)}</td></tr>`).join("") +
    `</tbody></table>`;
  $("list-box").querySelectorAll("tr.click").forEach((tr) => tr.onclick = () => openDetail(tr.dataset.id));
}

function pkgLabel(v) { return (PACKAGES.find((p) => p[0] === v) || [])[1] || "—"; }
function careLabel(v) { return (CARE_PLANS.find((p) => p[0] === v) || [])[1] || "None"; }

async function openDetail(id) {
  show("view-detail");
  $("detail-box").innerHTML = '<div class="spinner"></div>';
  const { data: it } = await sb.from("onb_intakes").select("*").eq("id", id).single();
  if (!it) { $("detail-box").innerHTML = '<p class="muted">Not found.</p>'; return; }
  const { data: assets } = await sb.from("onb_assets").select("*").eq("intake_id", id).order("created_at");
  const { data: events } = await sb.from("onb_events").select("*").eq("intake_id", id).order("created_at", { ascending: false });
  // sign the asset URLs
  await Promise.all((assets || []).map(async (a) => {
    const { data: s } = await sb.storage.from(CFG.STORAGE_BUCKET).createSignedUrl(a.storage_path, 3600);
    a.url = s ? s.signedUrl : null;
  }));
  $("detail-box").innerHTML = detailHtml(it, assets || [], events || []);
  wireDetail(it);
}

function detailHtml(it, assets, events) {
  const MODEL = specModel(it.product);
  const b = it.brand || {}, spec = it.spec || {};
  const designRows = Object.entries(DESIGN).map(([k, g]) => {
    const dev = (b.design_dev || {})[k]; const val = (b.design || {})[k];
    const label = dev ? '<span class="tag dev">designer\'s choice</span>' :
      val ? esc((g.options.find((o) => o[0] === val) || [])[1] || val) : "—";
    return `<dt>${esc(g.label)}</dt><dd>${label}</dd>`;
  }).join("");
  const listCol = (col, model) => model.map((s) => {
    const c = (spec[col] || {})[s.key] || {};
    if (c.dev_decides) return `<span class="tag dev">${esc(s.label)} · dev decides</span>`;
    if (c.include) return `<span class="tag">${esc(s.label)}${c.notes ? " ✎" : ""}</span>`;
    return "";
  }).join("") || "—";
  const notes = (col, model) => model.filter((s) => ((spec[col] || {})[s.key] || {}).notes)
    .map((s) => `<dt>${esc(s.label)}</dt><dd>${esc(spec[col][s.key].notes)}</dd>`).join("");
  const thumbs = assets.map((a) => a.url && (a.mime || "").startsWith("image/") && a.mime !== "image/svg+xml"
    ? `<a class="thumb" href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt=""><span class="kind">${esc(a.kind)}</span></a>`
    : `<a class="thumb pdf" href="${esc(a.url || "#")}" target="_blank" rel="noopener"><span>${esc(a.filename)}</span><span class="kind">${esc(a.kind)}</span></a>`).join("");

  return `
    <div class="doc">
      <h3>${esc(it.business_name) || "(untitled)"} · ${esc(PRODUCT_LABEL[it.product])}</h3>
      <dl>
        <dt>Contact</dt><dd>${esc(it.contact_name)} · ${esc(it.contact_email)} · ${esc(it.contact_phone)}</dd>
        <dt>Industry</dt><dd>${esc(it.industry) || "—"}</dd>
        <dt>Describes as</dt><dd>${esc(it.business_description) || "—"}</dd>
        <dt>Address</dt><dd>${esc((it.about || {}).address) || "—"}</dd>
        <dt>Hours</dt><dd>${esc((it.about || {}).hours) || "—"}</dd>
        <dt>Service area</dt><dd>${esc((it.about || {}).service_area) || "—"}</dd>
        <dt>Current web</dt><dd>${esc((it.about || {}).current_web) || "—"}</dd>${(it.about || {}).google_place_id ? `<dt>Google Place ID</dt><dd class="muted">${esc(it.about.google_place_id)}</dd>` : ""}
      </dl>
      <h3>Brand & look</h3>
      <dl>
        <dt>Colors</dt><dd>${(b.colors || []).map((c) => `<span class="tag"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${cssColor(c)};margin-right:5px"></span>${esc(c)}</span>`).join("") || "designer's choice"}</dd>
        <dt>Tagline</dt><dd>${esc(b.tagline) || "—"}</dd>
        ${designRows}
      </dl>
      <h3>Uploads (${assets.length})</h3>
      <div class="thumbs">${thumbs || '<span class="muted">None</span>'}</div>
      <h3>Page spec</h3>
      <dl>
        <dt>Sections</dt><dd>${listCol("sections", MODEL.sections)}</dd>
        <dt>Features</dt><dd>${listCol("integrations", MODEL.integrations)}</dd>
        <dt>Goal</dt><dd>${esc(spec.goals) || "—"}</dd>
        <dt>Must-haves</dt><dd>${esc(spec.must_haves) || "—"}</dd>
        <dt>Avoid</dt><dd>${esc(spec.avoid) || "—"}</dd>
        <dt>Inspiration</dt><dd>${esc(spec.inspiration) || "—"}</dd>
      </dl>
      ${notes("sections", MODEL.sections) || notes("integrations", MODEL.integrations)
        ? `<h3>Section notes</h3><dl>${notes("sections", MODEL.sections)}${notes("integrations", MODEL.integrations)}</dl>` : ""}
      <h3>Package & billing</h3>
      <dl>
        <dt>Build</dt><dd>${esc(pkgLabel(it.package))}</dd>
        <dt>Care plan</dt><dd>${esc(careLabel(it.care_plan))} · ${esc(it.billing_cycle || "monthly")}</dd>
      </dl>
      <h3>Contract</h3>
      <dl>
        <dt>Status</dt><dd><span class="pill ${esc(it.sign_status)}">${esc(it.sign_status)}</span></dd>
        <dt>Signed by</dt><dd>${esc(it.signed_name) || "—"} ${it.signed_at ? "· " + fmt(it.signed_at) : ""}</dd>
        <dt>Version / hash</dt><dd class="muted">${esc(it.agreement_version) || "—"} · ${esc((it.agreement_hash || "").slice(0, 16))}${it.agreement_hash ? "…" : ""}</dd>
        <dt>IP</dt><dd class="muted">${esc(it.signed_ip) || "—"}</dd>
      </dl>
      <h3>Payment</h3>
      <dl>
        <dt>Status</dt><dd><span class="pill ${esc(it.pay_status)}">${esc(it.pay_status.replace("_", " "))}</span></dd>
        <dt>Stripe customer</dt><dd class="muted">${esc(it.stripe_customer_id) || "—"}</dd>
        <dt>Subscription</dt><dd class="muted">${esc(it.stripe_subscription_id) || "—"}</dd>
      </dl>
      <h3>Activity</h3>
      <dl>${events.map((e) => `<dt>${fmt(e.created_at)}</dt><dd>${esc(e.kind)}</dd>`).join("") || '<dt class="muted">No events</dt><dd></dd>'}</dl>
    </div>

    <div class="card" style="margin-top:16px">
      <h3 style="font-family:'Rajdhani';margin-bottom:6px">Studio actions</h3>
      <p class="hint">Set the real deposit (overrides the package default at checkout), then set status to <b>accepted</b> to unlock the client's sign &amp; pay — their screen updates live. Use <b>declined</b> to close it.</p>
      <div class="admin-actions">
        <div class="field"><label>Deposit ($)</label><input type="number" id="a-deposit" min="0" step="0.01" value="${it.deposit_amount != null ? esc(it.deposit_amount) : ""}" placeholder="package default" style="width:150px"></div>
        <div class="field"><label>Status</label><select id="a-status" style="width:170px">
          ${["draft", "submitted", "in_review", "accepted", "declined"].map((s) => `<option value="${s}" ${it.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select></div>
        <button class="btn btn-ghost" id="a-save">Save deposit / status</button>
      </div>
      ${it.product === "groundwork" ? (it.project_id
        ? `<div class="banner ok" style="margin-top:14px">✓ In-service client created — <a href="/groundwork/admin/">open in the Groundwork admin →</a></div>`
        : (["submitted", "in_review", "accepted"].includes(it.status)
            ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
                 <button class="btn btn-primary" id="a-provision">Accept &amp; create Groundwork client →</button>
                 <p class="hint" style="margin-top:6px">Saves the deposit above (leave blank to keep the current one), accepts the brief (unlocking the client's sign &amp; pay), creates their in-service client record, and seeds their integrations from the spec. One click — no re-keying.</p>
               </div>`
            : `<p class="hint" style="margin-top:14px">Provisioning unlocks once the client submits their brief.</p>`)) : ""}
      <div class="error-text" id="a-err"></div>
    </div>`;
}

function wireDetail(it) {
  $("a-save").onclick = async () => {
    const btn = $("a-save"); btn.disabled = true; $("a-err").textContent = "";
    const dep = $("a-deposit").value.trim();
    const patch = { status: $("a-status").value, deposit_amount: dep === "" ? null : Number(dep) };
    const { error } = await sb.from("onb_intakes").update(patch).eq("id", it.id);
    btn.disabled = false;
    if (error) { $("a-err").textContent = error.message; return; }
    toast("Saved.", "ok");
    await sb.from("onb_events").insert({ intake_id: it.id, actor_id: user.id, kind: "admin_update", detail: patch }).catch(() => {});
    openDetail(it.id);
  };

  // Accept + provision the in-service Groundwork client in one step.
  const prov = $("a-provision");
  if (prov) prov.onclick = async () => {
    prov.disabled = true; $("a-err").textContent = "";
    const dep = $("a-deposit").value.trim();
    const { error } = await sb.rpc("onb_accept_and_provision", {
      p_intake: it.id, p_deposit: dep === "" ? null : Number(dep),
    });
    if (error) { prov.disabled = false; $("a-err").textContent = error.message; return; }
    toast("Accepted — Groundwork client created & integrations seeded.", "ok");
    openDetail(it.id); // refresh: shows the linked client + accepted status
  };
}

let toastTimer = null;
function toast(msg, kind) {
  const el = $("toast"); if (!el) return;
  el.textContent = msg; el.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = "toast"), 3000);
}
