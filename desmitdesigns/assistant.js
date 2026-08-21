/* ============================================================
 * DeSmit Designs — AI assistant widget (floating chat)
 *
 * Self-contained, dependency-free. Injects its own scoped styles + a launcher
 * bubble, and talks to the dd-assistant Edge Function. Reads window.DD_CONFIG
 * (from config.js). Drop <script src=".../assistant.js" defer></script> on any
 * page that also loads config.js. Safe to include signed-out.
 * ============================================================ */
(function () {
  "use strict";
  if (window.__ddAssistant) return;
  window.__ddAssistant = true;

  var CFG = window.DD_CONFIG || {};
  var ENDPOINT = CFG.ASSISTANT_FN || "";
  var CONFIGURED = ENDPOINT && ENDPOINT.indexOf("REPLACE_ME") === -1;

  // Conversation state: [{role, content}] of plain text turns.
  var history = [];
  var busy = false;

  // ---- styles (scoped under .dda-*) ----
  var css = "\
.dda-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:58px;height:58px;border:none;border-radius:50%;\
background:linear-gradient(135deg,#3b82f6,#06b6d4);color:#fff;cursor:pointer;box-shadow:0 8px 26px -8px rgba(59,130,246,.7);\
display:flex;align-items:center;justify-content:center;transition:transform .2s ease,box-shadow .2s ease}\
.dda-launch:hover{transform:translateY(-2px) scale(1.03)}\
.dda-launch svg{width:26px;height:26px}\
.dda-panel{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:360px;max-width:calc(100vw - 32px);height:520px;\
max-height:calc(100vh - 120px);background:#0f1626;color:#e2e8f0;border:1px solid #1e293b;border-radius:16px;\
box-shadow:0 24px 60px -20px rgba(0,0,0,.7);display:none;flex-direction:column;overflow:hidden;\
font-family:'Open Sans',system-ui,-apple-system,sans-serif}\
.dda-panel.dda-open{display:flex;animation:dda-in .22s ease}\
@keyframes dda-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}\
.dda-head{display:flex;align-items:center;gap:10px;padding:14px 16px;background:linear-gradient(135deg,#3b82f6,#06b6d4)}\
.dda-head b{font-family:'Rajdhani',system-ui,sans-serif;font-size:1.05rem;letter-spacing:.5px;color:#fff;flex:1}\
.dda-head small{color:rgba(255,255,255,.85);font-size:.72rem;display:block;font-weight:400}\
.dda-x{background:none;border:none;color:#fff;font-size:1.4rem;line-height:1;cursor:pointer;opacity:.85;padding:0 2px}\
.dda-x:hover{opacity:1}\
.dda-log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}\
.dda-msg{max-width:85%;padding:10px 13px;border-radius:14px;font-size:.9rem;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}\
.dda-bot{align-self:flex-start;background:#1a2332;border:1px solid #1e293b;border-bottom-left-radius:4px}\
.dda-user{align-self:flex-end;background:linear-gradient(135deg,#3b82f6,#06b6d4);color:#fff;border-bottom-right-radius:4px}\
.dda-msg a{color:#60a5fa}.dda-user a{color:#fff;text-decoration:underline}\
.dda-typing{align-self:flex-start;display:flex;gap:4px;padding:12px 14px;background:#1a2332;border:1px solid #1e293b;border-radius:14px}\
.dda-typing span{width:7px;height:7px;border-radius:50%;background:#64748b;animation:dda-blink 1.2s infinite}\
.dda-typing span:nth-child(2){animation-delay:.2s}.dda-typing span:nth-child(3){animation-delay:.4s}\
@keyframes dda-blink{0%,60%,100%{opacity:.3}30%{opacity:1}}\
.dda-form{display:flex;gap:8px;padding:12px;border-top:1px solid #1e293b;background:#0b1120}\
.dda-form input{flex:1;background:#111827;border:1px solid #1e293b;border-radius:10px;padding:10px 12px;color:#e2e8f0;font-size:.9rem;font-family:inherit}\
.dda-form input:focus{outline:none;border-color:#3b82f6}\
.dda-send{background:linear-gradient(135deg,#3b82f6,#06b6d4);border:none;border-radius:10px;width:42px;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}\
.dda-send:disabled{opacity:.5;cursor:default}.dda-send svg{width:18px;height:18px}\
@media (prefers-reduced-motion:reduce){.dda-panel.dda-open,.dda-launch:hover{animation:none;transform:none}}";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ---- DOM ----
  var launch = document.createElement("button");
  launch.className = "dda-launch";
  launch.setAttribute("aria-label", "Open the DeSmit Designs assistant");
  launch.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

  var panel = document.createElement("div");
  panel.className = "dda-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "DeSmit Designs assistant");
  panel.innerHTML =
    '<div class="dda-head"><div style="flex:1"><b>Studio Assistant</b>' +
    '<small>DeSmit Designs · usually a few seconds</small></div>' +
    '<button class="dda-x" aria-label="Close">×</button></div>' +
    '<div class="dda-log" role="log" aria-live="polite"></div>' +
    '<form class="dda-form"><input type="text" placeholder="Ask about a project…" ' +
    'aria-label="Message" autocomplete="off"/>' +
    '<button class="dda-send" type="submit" aria-label="Send">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
    '</button></form>';

  document.body.appendChild(launch);
  document.body.appendChild(panel);

  var log = panel.querySelector(".dda-log");
  var form = panel.querySelector(".dda-form");
  var input = panel.querySelector(".dda-form input");
  var sendBtn = panel.querySelector(".dda-send");
  var opened = false;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  // Render text with safe auto-links for relative paths, mailto, tel, and http.
  function render(text) {
    var out = esc(text);
    out = out.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    out = out.replace(/(^|[\s(])(\/[a-zA-Z0-9/_-]+\/?)/g, '$1<a href="$2">$2</a>');
    out = out.replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '<a href="mailto:$1">$1</a>');
    return out;
  }
  function addMsg(role, text) {
    var el = document.createElement("div");
    el.className = "dda-msg " + (role === "user" ? "dda-user" : "dda-bot");
    el.innerHTML = render(text);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function typing(on) {
    var ex = log.querySelector(".dda-typing");
    if (on && !ex) {
      var t = document.createElement("div");
      t.className = "dda-typing";
      t.innerHTML = "<span></span><span></span><span></span>";
      log.appendChild(t);
      log.scrollTop = log.scrollHeight;
    } else if (!on && ex) {
      ex.remove();
    }
  }

  function open() {
    panel.classList.add("dda-open");
    launch.style.display = "none";
    if (!opened) {
      opened = true;
      addMsg("bot", CONFIGURED
        ? "Hi! I'm the DeSmit Designs studio assistant. Ask me about 3D printing, laser work, CAD, or a custom project — or tell me what you'd like to make and I'll pass it to Daniel."
        : "The assistant isn't switched on yet — the studio is finishing setup. In the meantime, email desmitdesignz@gmail.com and Daniel will get right back to you.");
    }
    setTimeout(function () { input.focus(); }, 60);
  }
  function close() {
    panel.classList.remove("dda-open");
    launch.style.display = "flex";
  }

  launch.addEventListener("click", open);
  panel.querySelector(".dda-x").addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && panel.classList.contains("dda-open")) close();
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    if (!CONFIGURED) {
      input.value = "";
      addMsg("user", text);
      addMsg("bot", "I'm not connected yet — please email desmitdesignz@gmail.com for now.");
      return;
    }
    input.value = "";
    addMsg("user", text);
    history.push({ role: "user", content: text });
    send();
  });

  function send() {
    busy = true;
    sendBtn.disabled = true;
    typing(true);
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        typing(false);
        var reply = (data && data.reply) ||
          "Sorry — I hit a snag. You can reach the studio at desmitdesignz@gmail.com.";
        addMsg("bot", reply);
        history.push({ role: "assistant", content: reply });
      })
      .catch(function () {
        typing(false);
        addMsg("bot", "I couldn't reach the studio just now. Please email desmitdesignz@gmail.com.");
      })
      .finally(function () {
        busy = false;
        sendBtn.disabled = false;
        input.focus();
      });
  }
})();
