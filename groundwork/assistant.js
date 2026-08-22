/* ============================================================
 * Groundwork — AI assistant widget (floating chat)
 * Self-contained; talks to the gw-assistant Edge Function. Reads
 * window.GW_CONFIG (from portal/config.js). Drop this + config.js on any page.
 * ============================================================ */
(function () {
  "use strict";
  if (window.__gwAssistant) return;
  window.__gwAssistant = true;

  var CFG = window.GW_CONFIG || {};
  var ENDPOINT = CFG.ASSISTANT_FN || "";
  var CONFIGURED = ENDPOINT && ENDPOINT.indexOf("REPLACE_ME") === -1;
  var history = [];
  var busy = false;

  var css = "\
.gwa-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:58px;height:58px;border:none;border-radius:50%;\
background:linear-gradient(135deg,#4a9e7e,#4ade80);color:#071410;cursor:pointer;box-shadow:0 8px 26px -8px rgba(74,158,126,.7);\
display:flex;align-items:center;justify-content:center;transition:transform .2s ease}\
.gwa-launch:hover{transform:translateY(-2px) scale(1.03)}.gwa-launch svg{width:26px;height:26px}\
.gwa-panel{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:360px;max-width:calc(100vw - 32px);height:520px;\
max-height:calc(100vh - 120px);background:#0b1210;color:#e2e8e6;border:1px solid #1a2f28;border-radius:16px;\
box-shadow:0 24px 60px -20px rgba(0,0,0,.7);display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}\
.gwa-panel.gwa-open{display:flex;animation:gwa-in .22s ease}\
@keyframes gwa-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}\
.gwa-head{display:flex;align-items:center;gap:10px;padding:14px 16px;background:linear-gradient(135deg,#4a9e7e,#4ade80)}\
.gwa-head b{font-size:1.05rem;color:#071410;flex:1;font-weight:700}.gwa-head small{color:rgba(7,20,16,.75);font-size:.72rem;display:block;font-weight:500}\
.gwa-x{background:none;border:none;color:#071410;font-size:1.4rem;line-height:1;cursor:pointer;opacity:.8;padding:0 2px}.gwa-x:hover{opacity:1}\
.gwa-log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}\
.gwa-msg{max-width:85%;padding:10px 13px;border-radius:14px;font-size:.9rem;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}\
.gwa-bot{align-self:flex-start;background:#111f1b;border:1px solid #1a2f28;border-bottom-left-radius:4px}\
.gwa-user{align-self:flex-end;background:linear-gradient(135deg,#4a9e7e,#4ade80);color:#071410;border-bottom-right-radius:4px}\
.gwa-msg a{color:#5fb896}.gwa-user a{color:#071410;text-decoration:underline}\
.gwa-typing{align-self:flex-start;display:flex;gap:4px;padding:12px 14px;background:#111f1b;border:1px solid #1a2f28;border-radius:14px}\
.gwa-typing span{width:7px;height:7px;border-radius:50%;background:#5a6b64;animation:gwa-blink 1.2s infinite}\
.gwa-typing span:nth-child(2){animation-delay:.2s}.gwa-typing span:nth-child(3){animation-delay:.4s}\
@keyframes gwa-blink{0%,60%,100%{opacity:.3}30%{opacity:1}}\
.gwa-form{display:flex;gap:8px;padding:12px;border-top:1px solid #1a2f28;background:#0a0f0d}\
.gwa-form input{flex:1;background:#111f1b;border:1px solid #1a2f28;border-radius:10px;padding:10px 12px;color:#e2e8e6;font-size:.9rem;font-family:inherit}\
.gwa-form input:focus{outline:none;border-color:#4a9e7e}\
.gwa-send{background:linear-gradient(135deg,#4a9e7e,#4ade80);border:none;border-radius:10px;width:42px;color:#071410;cursor:pointer;display:flex;align-items:center;justify-content:center}\
.gwa-send:disabled{opacity:.5}.gwa-send svg{width:18px;height:18px}\
@media (prefers-reduced-motion:reduce){.gwa-panel.gwa-open,.gwa-launch:hover{animation:none;transform:none}}";
  var style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

  var launch = document.createElement("button");
  launch.className = "gwa-launch"; launch.setAttribute("aria-label", "Open the Groundwork assistant");
  launch.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

  var panel = document.createElement("div");
  panel.className = "gwa-panel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Groundwork assistant");
  panel.innerHTML =
    '<div class="gwa-head"><div style="flex:1"><b>Groundwork Assistant</b><small>Lost Pines Creative · usually a few seconds</small></div>' +
    '<button class="gwa-x" aria-label="Close">×</button></div>' +
    '<div class="gwa-log" role="log" aria-live="polite"></div>' +
    '<form class="gwa-form"><input type="text" placeholder="Ask about your business systems…" aria-label="Message" autocomplete="off"/>' +
    '<button class="gwa-send" type="submit" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></form>';

  document.body.appendChild(launch); document.body.appendChild(panel);
  var log = panel.querySelector(".gwa-log"), form = panel.querySelector(".gwa-form"),
      input = panel.querySelector(".gwa-form input"), sendBtn = panel.querySelector(".gwa-send"), opened = false;

  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
  function render(t){var o=esc(t);o=o.replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');o=o.replace(/(^|[\s(])(\/[a-zA-Z0-9/_.-]+)/g,'$1<a href="$2">$2</a>');o=o.replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,'<a href="mailto:$1">$1</a>');return o;}
  function addMsg(role,t){var e=document.createElement("div");e.className="gwa-msg "+(role==="user"?"gwa-user":"gwa-bot");e.innerHTML=render(t);log.appendChild(e);log.scrollTop=log.scrollHeight;}
  function typing(on){var ex=log.querySelector(".gwa-typing");if(on&&!ex){var t=document.createElement("div");t.className="gwa-typing";t.innerHTML="<span></span><span></span><span></span>";log.appendChild(t);log.scrollTop=log.scrollHeight;}else if(!on&&ex){ex.remove();}}

  function open(){panel.classList.add("gwa-open");launch.style.display="none";if(!opened){opened=true;addMsg("bot",CONFIGURED?"Hi! I'm the Groundwork assistant. Ask me how I'd connect your business tools and add AI — or I can book your free digital audit.":"The assistant isn't switched on yet. Email desmitdesignz@gmail.com and Daniel will get right back to you.");}setTimeout(function(){input.focus();},60);}
  function close(){panel.classList.remove("gwa-open");launch.style.display="flex";}
  launch.addEventListener("click",open);panel.querySelector(".gwa-x").addEventListener("click",close);
  document.addEventListener("keydown",function(e){if(e.key==="Escape"&&panel.classList.contains("gwa-open"))close();});

  form.addEventListener("submit",function(e){e.preventDefault();var text=input.value.trim();if(!text||busy)return;
    if(!CONFIGURED){input.value="";addMsg("user",text);addMsg("bot","I'm not connected yet — please email desmitdesignz@gmail.com for now.");return;}
    input.value="";addMsg("user",text);history.push({role:"user",content:text});send();});

  function send(){busy=true;sendBtn.disabled=true;typing(true);
    fetch(ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:history})})
      .then(function(r){return r.json().catch(function(){return {};});})
      .then(function(d){typing(false);var reply=(d&&d.reply)||"Sorry — I hit a snag. Reach Daniel at desmitdesignz@gmail.com.";addMsg("bot",reply);history.push({role:"assistant",content:reply});})
      .catch(function(){typing(false);addMsg("bot","I couldn't connect just now. Please email desmitdesignz@gmail.com.");})
      .finally(function(){busy=false;sendBtn.disabled=false;input.focus();});}
})();
