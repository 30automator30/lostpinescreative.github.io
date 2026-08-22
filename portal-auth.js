/* ============================================================
 * Shared email + password auth for the DeSmit + Groundwork portals/admins.
 * Wires the standard auth form (sign in / create account / forgot password)
 * and password-recovery. Each app imports { initAuth, isRecovering } and
 * passes its own `sb` client + redirect URL. Routing stays in each app's
 * routeSession (which should early-return while isRecovering()).
 *
 * Required element IDs on the page:
 *   view-auth, view-sent, view-reset-sent, view-setpw   (.view sections)
 *   auth-form, email, password, auth-btn, auth-error, toggle-mode, forgot
 *   setpw-form, setpw, setpw-btn, setpw-error
 *   sent-to (optional, filled on signup-confirmation)
 * ============================================================ */
let recovering = false;
export function isRecovering() { return recovering; }

function view(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id));
  window.scrollTo({ top: 0 });
}
const $ = (id) => document.getElementById(id);

export function initAuth(sb, redirect) {
  const back = redirect || (location.origin + location.pathname); // return to this page
  let mode = "signin";
  function setMode(m) {
    mode = m;
    $("auth-btn").textContent = m === "signup" ? "Create account" : "Sign in";
    $("password").setAttribute("autocomplete", m === "signup" ? "new-password" : "current-password");
    $("toggle-mode").textContent = m === "signup" ? "Have an account? Sign in" : "Create an account";
    $("auth-error").textContent = "";
  }

  // password recovery: clicking the reset email lands here and fires this event
  sb.auth.onAuthStateChange((evt) => {
    if (evt === "PASSWORD_RECOVERY") { recovering = true; view("view-setpw"); }
  });

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("email").value.trim(), pw = $("password").value;
    if (!email || !pw) return;
    const b = $("auth-btn"); b.disabled = true; $("auth-error").textContent = "";
    const res = mode === "signup"
      ? await sb.auth.signUp({ email, password: pw, options: { emailRedirectTo: back } })
      : await sb.auth.signInWithPassword({ email, password: pw });
    b.disabled = false;
    if (res.error) { $("auth-error").textContent = res.error.message; return; }
    // signup with email-confirmation ON returns no session — tell them to confirm
    if (mode === "signup" && !(res.data && res.data.session)) {
      if ($("sent-to")) $("sent-to").textContent = email;
      view("view-sent");
    }
    // otherwise onAuthStateChange (SIGNED_IN) routes to the dashboard
  });

  $("toggle-mode").addEventListener("click", (e) => { e.preventDefault(); setMode(mode === "signin" ? "signup" : "signin"); });

  $("forgot").addEventListener("click", async (e) => {
    e.preventDefault();
    const email = $("email").value.trim();
    if (!email) { $("auth-error").textContent = "Enter your email first, then click Forgot password."; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: back });
    if (error) { $("auth-error").textContent = error.message; return; }
    view("view-reset-sent");
  });

  if ($("sent-back")) $("sent-back").addEventListener("click", () => view("view-auth"));
  if ($("reset-back")) $("reset-back").addEventListener("click", () => view("view-auth"));

  const spf = $("setpw-form");
  if (spf) spf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("setpw").value;
    $("setpw-error").textContent = "";
    if (!pw || pw.length < 8) { $("setpw-error").textContent = "Use at least 8 characters."; return; }
    const b = $("setpw-btn"); b.disabled = true;
    const { error } = await sb.auth.updateUser({ password: pw });
    b.disabled = false;
    if (error) { $("setpw-error").textContent = error.message; return; }
    recovering = false;
    // reload clean (session is now a normal one) → routes to the dashboard
    location.replace(location.pathname);
  });

  setMode("signin");
}
