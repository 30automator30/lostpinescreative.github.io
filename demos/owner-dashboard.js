/*
 * Groundwork — reusable owner dashboard engine.
 * Reads window.OWNER_DASH_CONFIG and renders a full-screen, tabbed backend:
 * Overview · Appointments · Team & dispatch · Reports · Payroll & analytics.
 * Pure vanilla JS, no backend. window.openOwnerDash() / closeOwnerDash().
 */
(function () {
  var cfg = window.OWNER_DASH_CONFIG;
  if (!cfg) return;
  var T = cfg.terms || {};
  var CUR = cfg.cur || '$';
  var overlay, main, state, built = false, active = 'overview';
  var LEVELS = cfg.levels || null, level = null;

  /* ---- helpers ---- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function money(n) { return CUR + Number(n).toLocaleString('en-US'); }
  function initials(name) { return name.trim().split(/\s+/).map(function (p) { return p[0]; }).slice(0, 2).join('').toUpperCase(); }

  function barChart(data, unit) {
    var max = Math.max.apply(null, data.map(function (d) { return d[1]; })) || 1;
    var cols = data.map(function (d) {
      var peak = d[1] === max ? ' peak' : '';
      var h = Math.max(4, (d[1] / max) * 100);
      return '<div class="col' + peak + '"><div class="bar" style="height:' + h + '%"><span class="v">' + esc(d[1]) + (unit || '') + '</span></div><span class="lab">' + esc(d[0]) + '</span></div>';
    }).join('');
    return '<div class="oda-bars">' + cols + '</div>';
  }
  function hbars(data, fmt) {
    var max = Math.max.apply(null, data.map(function (d) { return d[1]; })) || 1;
    return '<div class="oda-hbars">' + data.map(function (d) {
      return '<div class="oda-hb"><span class="nm">' + esc(d[0]) + '</span><span class="track"><span class="fill" style="width:' + ((d[1] / max) * 100) + '%"></span></span><span class="val">' + esc(fmt ? fmt(d[1]) : d[1]) + '</span></div>';
    }).join('') + '</div>';
  }

  var ICON = {
    grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
    cal: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    team: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 6a3 3 0 0 1 0 6M17.5 20a6 6 0 0 0-3-5.2"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9v6M18 9v6"/>'
  };
  function svg(p) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }

  var TABS = [
    { id: 'level', label: 'What you get', icon: '<path d="M5 12l4 4L19 6"/>', render: renderLevel, only: !!LEVELS },
    { id: 'overview', label: 'Overview', icon: ICON.grid, render: renderOverview },
    { id: 'inbox', label: 'Inbox', icon: ICON.cal, render: renderInbox, only: !!cfg.inbox },
    { id: 'appointments', label: (T.schedule || 'Appointments'), icon: ICON.cal, render: renderAppointments },
    { id: 'team', label: (T.team || 'Team') + ' & dispatch', icon: ICON.team, render: renderTeam },
    { id: 'reports', label: 'Reports', icon: ICON.chart, render: renderReports },
    { id: 'payroll', label: 'Payroll', icon: ICON.cash, render: renderPayroll }
  ].filter(function (t) { return t.only !== false; });

  /* Optional "what's included" labelling (off unless the demo's config sets it):
     cfg.soon = { tabId|revenue: true } marks previews of features not built yet;
     cfg.included / cfg.soonList fill the key at the top of the Overview;
     kpis[].inc / kpis[].soon put a pill on a tile. */
  var SOON = cfg.soon || {}, L = cfg.labels || {};
  function pill(kind) {
    if (LEVELS) return '';
    if (kind === 'inc') return '<span class="oda-pill inc">' + esc(L.inc || 'Included') + '</span>';
    if (kind === 'soon') return '<span class="oda-pill soon">' + esc(L.soon || 'Coming soon') + '</span>';
    return '';
  }
  function soonBar(what) {
    if (L.soonBar) return '<div class="oda-soonbar">' + pill('soon') + '<span>' + esc(L.soonBar.replace('{what}', what)) + '</span></div>';
    return '<div class="oda-soonbar">' + pill('soon') + '<span><b>Preview.</b> ' + esc(what) +
      ' is on our roadmap and is not part of the current build. Sample data shown.</span></div>';
  }

  /* ---- build shell ---- */
  function build() {
    overlay = document.createElement('div');
    overlay.className = 'oda';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Owner dashboard — ' + (cfg.business || ''));
    var theme = cfg.theme || {};
    Object.keys(theme).forEach(function (k) { overlay.style.setProperty('--d-' + k, theme[k]); });

    overlay.innerHTML =
      '<div class="oda-top">' +
        '<span class="oda-mark">' + (cfg.markSvg || svg(ICON.grid)) + '</span>' +
        '<span class="oda-brand"><b>' + esc(cfg.business || 'Business') + '</b><small>' + esc(cfg.label || 'Owner dashboard') + '</small></span>' +
        '<span class="oda-live"><span class="pip"></span>' + esc(cfg.liveLabel || 'Live') + ' · ' + esc(cfg.today || 'Today') + '</span>' +
        '<button class="oda-close" aria-label="Close dashboard">×</button>' +
      '</div>' +
      (LEVELS ? '<div class="oda-levels" id="odaLevels" role="tablist" aria-label="Package level"></div>' : '') +
      '<div class="oda-tabs" id="odaTabs"></div>' +
      '<div class="oda-main"><div class="oda-wrap" id="odaMain"></div></div>';

    document.body.appendChild(overlay);
    main = overlay.querySelector('#odaMain');
    buildTabs();
    if (LEVELS) {
      var lv = overlay.querySelector('#odaLevels');
      lv.style.setProperty('--n', LEVELS.length);
      LEVELS.forEach(function (l) {
        var b = document.createElement('button');
        b.className = 'oda-level';
        b.setAttribute('role', 'tab');
        b.setAttribute('data-level', l.id);
        b.innerHTML = '<b>' + esc(l.name) + '</b><span class="pr">' + esc(l.price) + '</span><span class="tg">' + esc(l.tag || '') + '</span>';
        b.onclick = function () { setLevel(l.id); };
        lv.appendChild(b);
      });
      var zoom = document.createElement('div');
      zoom.className = 'oda-zoom';
      zoom.innerHTML = '<img alt=""><p></p>';
      zoom.onclick = function () { zoom.classList.remove('open'); };
      overlay.appendChild(zoom);
    }
    overlay.querySelector('.oda-close').onclick = closeOwnerDash;
    built = true;
  }

  function buildTabs() {
    var tabsEl = overlay.querySelector('#odaTabs');
    tabsEl.innerHTML = '';
    var ids = LEVELS ? ((level && level.tabs) || ['level']) : null;
    var list = TABS.filter(function (t) { return !ids || ids.indexOf(t.id) > -1; });
    tabsEl.style.display = list.length > 1 ? '' : 'none';
    list.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'oda-tab' + (t.id === active ? ' on' : '');
      b.setAttribute('data-tab', t.id);
      b.innerHTML = svg(t.icon) + esc(t.label) + (SOON[t.id] && !LEVELS ? ' <span class="oda-pill soon sm">' + esc(L.soonShort || 'Soon') + '</span>' : '');
      b.onclick = function () { show(t.id); };
      tabsEl.appendChild(b);
    });
  }
  function setLevel(id) {
    level = LEVELS.filter(function (l) { return l.id === id; })[0] || LEVELS[0];
    Array.prototype.forEach.call(overlay.querySelectorAll('.oda-level'), function (b) {
      var on = b.getAttribute('data-level') === level.id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    active = 'level';
    buildTabs();
    show('level');
  }

  /* ---- Package level: what to expect, with screens from the Lost Pines app ----
     Level fields (all optional except id/name/price/title):
       gets/later: [string | {t, d, p}]   shots: [{src, cap, alt}]
       addons: [{t, d, p, was}] + addonsTitle/addonsNote   deal: {was, now, label, note}
       embed: [{sel, title, sub}] moves an element from the page into this level
       actions: [{label, fn}] buttons that close the dashboard and call window[fn]()
       tabs: tab ids shown for this level (default: just "What you get") */
  var embedCache = {};
  function embedNode(sel) {
    if (!embedCache[sel]) embedCache[sel] = document.querySelector(sel);
    return embedCache[sel];
  }
  function renderLevel() {
    var l = level, i = LEVELS.indexOf(l);
    function item(x) {
      if (typeof x === 'string') return '<li>' + esc(x) + '</li>';
      return '<li><b>' + esc(x.t) + '</b>' + (x.p ? ' <span class="pr">' + esc(x.p) + '</span>' : '') + (x.d ? '<span>' + esc(x.d) + '</span>' : '') + '</li>';
    }
    var li = function (xs, cls) { return '<ul class="' + cls + '">' + (xs || []).map(item).join('') + '</ul>'; };
    var shots = (l.shots || []).map(function (sh, k) {
      return '<figure class="oda-shot"><button class="oda-phone" data-k="' + k + '" aria-label="Enlarge: ' + esc(sh.cap) + '"><img src="' + esc(sh.src) + '" alt="' + esc(sh.alt || sh.cap) + '" loading="lazy"></button><figcaption>' + esc(sh.cap) + '</figcaption></figure>';
    }).join('');
    var addons = (l.addons || []).map(function (a) {
      return '<li><div><b>' + esc(a.t) + '</b>' + (a.d ? '<span>' + esc(a.d) + '</span>' : '') + (a.was ? '<em>' + esc(a.was) + '</em>' : '') + '</div><span class="amt">' + esc(a.p) + '</span></li>';
    }).join('');
    var deal = l.deal ? '<div class="oda-deal"><span class="lb">' + esc(l.deal.label || '') + '</span><span class="was">' + esc(l.deal.was) + '</span><span class="now">' + esc(l.deal.now) + '</span>' + (l.deal.note ? '<small>' + esc(l.deal.note) + '</small>' : '') + '</div>' : '';
    var embeds = (l.embed || []).map(function (e, k) {
      return '<div class="oda-sec"><h3 class="oda-h" style="font-size:1rem">' + esc(e.title || '') + '</h3>' + (e.sub ? '<p class="oda-sub">' + esc(e.sub) + '</p>' : '') + '<div class="oda-embed" data-e="' + k + '"></div></div>';
    }).join('');
    var actions = (l.actions || []).map(function (a, k) { return '<button class="oda-btn oda-btn-accent" data-a="' + k + '">' + esc(a.label) + '</button>'; }).join('');
    var next = LEVELS[i + 1];
    main.innerHTML =
      '<div class="oda-lvhead"><p class="oda-eyebrow">' + esc(l.name) + ' · ' + esc(l.price) + '</p>' +
        '<h2 class="oda-h">' + esc(l.title) + '</h2><p class="oda-sub">' + esc(l.intro || '') + '</p></div>' +
      '<div class="oda-lvgrid' + (shots ? '' : ' solo') + '">' +
        '<div class="oda-card"><h3>What you get</h3>' + li(l.gets, 'oda-gets') +
          (l.later && l.later.length ? '<h3 class="mt">Not in this level</h3>' + li(l.later, 'oda-later') : '') +
          (l.note ? '<p class="oda-sub oda-note">' + esc(l.note) + '</p>' : '') +
          (actions ? '<div class="oda-acts">' + actions + '</div>' : '') + '</div>' +
        (shots ? '<div class="oda-shots-wrap"><h3 class="oda-h" style="font-size:1rem">' + esc(l.shotsTitle || 'In the Lost Pines app') + '</h3><div class="oda-shots">' + shots + '</div></div>' : '') +
      '</div>' +
      (addons ? '<div class="oda-sec oda-card"><h3>' + esc(l.addonsTitle || 'Add-ons') + '</h3><ul class="oda-addons">' + addons + '</ul>' + deal + (l.addonsNote ? '<p class="oda-sub oda-note">' + esc(l.addonsNote) + '</p>' : '') + '</div>' : deal) +
      embeds +
      (l.tabs && l.tabs.length > 1 ? '<div class="oda-row oda-sec"><span class="oda-sub" style="margin:0">' + esc(l.more || 'More in the tabs above.') + '</span><button class="oda-btn oda-btn-accent" id="odaMore">' + esc(l.moreBtn || 'Open the dashboard') + ' →</button></div>' : '') +
      (next ? '<div class="oda-row oda-sec"><span class="oda-sub" style="margin:0">' + esc(l.teaser || '') + '</span><button class="oda-btn" id="odaNext">See ' + esc(next.name) + ' →</button></div>' : '');
    (l.embed || []).forEach(function (e, k) {
      var n = embedNode(e.sel), slot = main.querySelector('.oda-embed[data-e="' + k + '"]');
      if (n && slot) slot.appendChild(n);
    });
    Array.prototype.forEach.call(main.querySelectorAll('.oda-phone'), function (b) {
      b.onclick = function () {
        var sh = l.shots[+b.getAttribute('data-k')], z = overlay.querySelector('.oda-zoom');
        z.querySelector('img').src = sh.src; z.querySelector('img').alt = sh.alt || sh.cap; z.querySelector('p').textContent = sh.cap;
        z.classList.add('open');
      };
    });
    Array.prototype.forEach.call(main.querySelectorAll('[data-a]'), function (b) {
      b.onclick = function () { var f = window[l.actions[+b.getAttribute('data-a')].fn]; closeOwnerDash(); if (typeof f === 'function') f(); };
    });
    var m = main.querySelector('#odaMore'); if (m) m.onclick = function () { show(l.tabs[1]); };
    var n = main.querySelector('#odaNext'); if (n) n.onclick = function () { setLevel(next.id); };
  }

  function show(id) {
    active = id;
    Array.prototype.forEach.call(overlay.querySelectorAll('.oda-tab'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === id);
    });
    var tab = TABS.filter(function (t) { return t.id === id; })[0];
    main.scrollTop = 0;
    overlay.querySelector('.oda-main').scrollTop = 0;
    tab.render();
  }

  /* ---- Overview ---- */
  function renderOverview() {
    var kpis = (cfg.kpis || []).map(function (k) {
      return '<div class="oda-kpi"><div class="n">' + esc(k.n) + '</div><div class="l">' + esc(k.l) + '</div>' +
        (k.d ? '<div class="d ' + (k.up ? 'up' : 'down') + '">' + (k.up ? '▲' : '▼') + ' ' + esc(k.d) + '</div>' : '') +
        (k.inc ? pill('inc') : k.soon ? pill('soon') : '') + '</div>';
    }).join('');

    var appts = (cfg.appointments && cfg.appointments.today) || [];
    var snapshot = appts.slice(0, 4).map(function (a) {
      return '<div class="oda-appt"><span class="time">' + esc(a.t) + '</span>' +
        '<span class="cust"><b>' + esc(a.c) + '</b><span>' + esc(a.s) + '</span></span>' +
        '<span class="who"><b>' + esc(a.who) + '</b></span>' +
        badge(a.st) + '</div>';
    }).join('');

    var team = (cfg.team || []);
    var onjob = team.filter(function (m) { return /job|route/i.test(m.status); }).length;

    var key = '';
    if (!LEVELS && (cfg.included || cfg.soonList)) {
      var li = function (xs) { return '<ul>' + (xs || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'; };
      key = '<div class="oda-key">' +
        '<div><h3>' + pill('inc') + ' ' + esc(L.keyInc || 'In your build') + '</h3>' + li(cfg.included) + '</div>' +
        '<div><h3>' + pill('soon') + ' ' + esc(L.keySoon || 'On the roadmap') + '</h3>' + li(cfg.soonList) + '</div>' +
      '</div>';
    }
    main.innerHTML =
      '<h2 class="oda-h">This week at a glance</h2>' +
      '<p class="oda-sub">' + (cfg.overviewSub ? esc(cfg.overviewSub) : 'The part your competition doesn’t have — every call, ' + esc((T.job || 'job').toLowerCase()) + ', and dollar in one place.') + '</p>' +
      key +
      '<div class="oda-kpis">' + kpis + '</div>' +
      '<div class="oda-sec oda-grid2">' +
        '<div class="oda-card"><h3>Revenue this week <span class="tag">collected</span>' + (SOON.revenue ? pill('soon') : '') + '</h3>' + barChart(cfg.revenue || [], 'k') + '</div>' +
        '<div class="oda-card"><h3>Today’s ' + esc((T.jobs || 'jobs').toLowerCase()) + ' <span class="tag">' + appts.length + ' scheduled</span>' + (SOON.appointments ? pill('soon') : '') + '</h3>' + (snapshot || '<p class="oda-sub" style="margin:0">Nothing booked yet.</p>') + '</div>' +
      '</div>' +
      '<div class="oda-sec oda-card"><h3>' + esc(T.team || 'Team') + ' right now <span class="tag">' + onjob + ' of ' + team.length + ' active</span>' + (SOON.team ? pill('soon') : '') + '</h3>' +
        '<div class="oda-team">' + team.map(teamMini).join('') + '</div></div>';
  }
  function teamMini(m) {
    var cls = statClass(m.status);
    return '<div class="oda-tm"><div class="row1"><span class="ava">' + esc(initials(m.name)) + '</span>' +
      '<span><span class="nm">' + esc(m.name) + '</span><br><span class="rl">' + esc(m.role) + '</span></span>' +
      '<span class="stat ' + cls + '"><span class="dot"></span>' + esc(m.status) + '</span></div>' +
      '<div class="meta"><span>' + esc(T.location || 'Location') + ': <b>' + esc(m.where) + '</b></span><span><b>' + esc(m.jobs) + '</b> ' + esc((T.jobs || 'jobs').toLowerCase()) + ' today</span></div>' +
      '<div class="oda-util"><i style="width:' + (m.util || 0) + '%"></i></div></div>';
  }
  function statClass(s) {
    s = (s || '').toLowerCase();
    if (s.indexOf('route') > -1) return 'enroute';
    if (s.indexOf('avail') > -1) return 'available';
    if (s.indexOf('off') > -1) return 'off';
    return 'onjob';
  }
  function badge(st) {
    var map = { done: 'Done', enroute: 'En route', progress: 'In progress', confirmed: 'Confirmed' };
    return '<span class="oda-badge ' + esc(st) + '">' + esc(map[st] || st) + '</span>';
  }

  /* ---- Appointments ---- */
  var apptDay = 'today';
  /* ---- Inbox (calls, missed calls, text-backs, leads) ---- */
  function renderInbox() {
    var ib = cfg.inbox || {};
    var rows = (ib.items || []).map(function (m) {
      return '<div class="oda-appt"><span class="time">' + esc(m.t) + '</span>' +
        '<span class="cust"><b>' + esc(m.from) + '</b><span>' + esc(m.text) + '</span></span>' +
        '<span class="who"><b>' + esc(m.kind) + '</b></span>' +
        (m.st ? '<span class="oda-badge">' + esc(m.st) + '</span>' : '') + '</div>';
    }).join('');
    main.innerHTML =
      '<h2 class="oda-h">Inbox ' + pill('inc') + '</h2>' +
      '<p class="oda-sub">' + esc(ib.sub || 'Every call, missed call, voicemail and estimate request lands here as it happens.') + '</p>' +
      '<div class="oda-card"><h3>Latest <span class="tag">sample</span></h3>' + rows + '</div>' +
      (ib.report ? '<div class="oda-sec oda-card"><h3>Monthly report ' + pill('inc') + '</h3><p class="oda-sub" style="margin:0">' + esc(ib.report) + '</p></div>' : '');
  }

  function renderAppointments() {
    var days = cfg.appointments || { today: [], tomorrow: [] };
    var list = days[apptDay] || [];
    var counts = {};
    list.forEach(function (a) { counts[a.st] = (counts[a.st] || 0) + 1; });
    main.innerHTML = (SOON.appointments ? soonBar('Job scheduling') : '') +
      '<h2 class="oda-h">' + (T.schedule || 'Appointments') + '</h2>' +
      '<p class="oda-sub">Every ' + (T.job || 'job').toLowerCase() + ', who’s on it, and where it stands — live as they come in.</p>' +
      '<div class="oda-row"><div class="oda-seg" id="apptSeg">' +
        '<button data-d="today" class="' + (apptDay === 'today' ? 'on' : '') + '">Today</button>' +
        '<button data-d="tomorrow" class="' + (apptDay === 'tomorrow' ? 'on' : '') + '">Tomorrow</button></div>' +
        '<span class="oda-sub" style="margin:0">' + list.length + ' ' + esc((T.jobs || 'jobs').toLowerCase()) + ' · ' + (counts.done || 0) + ' done · ' + ((counts.enroute || 0) + (counts.progress || 0)) + ' in progress</span>' +
      '</div>' +
      '<div class="oda-card"><div class="oda-appt" style="border-bottom:1px solid var(--d-line);font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--d-muted)">' +
        '<span>Time</span><span>Customer</span><span>' + esc(T.member || 'Assigned') + '</span><span>Status</span></div>' +
        list.map(function (a) {
          return '<div class="oda-appt"><span class="time">' + esc(a.t) + '</span>' +
            '<span class="cust"><b>' + esc(a.c) + '</b><span>' + esc(a.s) + ' · ' + esc(a.area) + '</span></span>' +
            '<span class="who"><b>' + esc(a.who) + '</b></span>' + badge(a.st) + '</div>';
        }).join('') +
      '</div>';
    var seg = overlay.querySelector('#apptSeg');
    Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
      b.onclick = function () { apptDay = b.getAttribute('data-d'); renderAppointments(); };
    });
  }

  /* ---- Team & dispatch ---- */
  function renderTeam() {
    main.innerHTML = (SOON.team ? soonBar((T.team || 'Team') + ' & dispatch') : '') +
      '<h2 class="oda-h">' + esc(T.team || 'Team') + ' & dispatch</h2>' +
      '<p class="oda-sub">See who’s where, who’s free, and assign the next ' + esc((T.job || 'job').toLowerCase()) + ' in one tap.</p>' +
      (state.unassigned.length
        ? '<div class="oda-card oda-sec" style="margin-top:0"><h3>Unassigned <span class="tag">' + state.unassigned.length + ' waiting</span></h3><div class="oda-unassigned" id="unassigned"></div></div>'
        : '<div class="oda-banner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>All ' + esc((T.jobs || 'jobs').toLowerCase()) + ' assigned — nice.</div>') +
      '<div class="oda-sec"><h3 class="oda-h" style="font-size:1rem">Roster</h3><div class="oda-team" id="roster"></div></div>';
    renderRoster();
    if (state.unassigned.length) renderUnassigned();
  }
  function renderRoster() {
    overlay.querySelector('#roster').innerHTML = state.team.map(function (m, i) {
      var cls = statClass(m.status);
      return '<div class="oda-tm"><div class="row1"><span class="ava">' + esc(initials(m.name)) + '</span>' +
        '<span><span class="nm">' + esc(m.name) + '</span><br><span class="rl">' + esc(m.role) + '</span></span>' +
        '<span class="stat ' + cls + '"><span class="dot"></span>' + esc(m.status) + '</span></div>' +
        '<div class="meta"><span>' + (m.now ? 'Now: <b>' + esc(m.now) + '</b>' : esc(T.location || 'At') + ': <b>' + esc(m.where) + '</b>') + '</span><span><b>' + esc(m.jobs) + '</b> today</span></div>' +
        '<div class="oda-util"><i style="width:' + (m.util || 0) + '%"></i></div></div>';
    }).join('');
  }
  function renderUnassigned() {
    var box = overlay.querySelector('#unassigned');
    if (!box) return;
    box.innerHTML = state.unassigned.map(function (j, i) {
      var opts = state.team.map(function (m, mi) {
        return '<button data-m="' + mi + '">' + esc(m.name) + '<small>' + esc(m.status) + '</small></button>';
      }).join('');
      return '<div class="oda-un"><span class="time">' + esc(j.t) + '</span>' +
        '<span class="info"><b>' + esc(j.s) + '</b><span>' + esc(j.c) + ' · ' + esc(j.area) + '</span></span>' +
        '<span class="oda-assign"><button class="oda-btn oda-btn-accent" data-j="' + i + '">Assign ▾</button>' +
        '<span class="oda-menu" data-menu="' + i + '">' + opts + '</span></span></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.oda-btn[data-j]'), function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var m = box.querySelector('.oda-menu[data-menu="' + btn.getAttribute('data-j') + '"]');
        var open = m.classList.contains('open');
        Array.prototype.forEach.call(box.querySelectorAll('.oda-menu'), function (x) { x.classList.remove('open'); });
        if (!open) m.classList.add('open');
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('.oda-menu'), function (menu) {
      var ji = +menu.getAttribute('data-menu');
      Array.prototype.forEach.call(menu.querySelectorAll('button'), function (opt) {
        opt.onclick = function () { assign(ji, +opt.getAttribute('data-m')); };
      });
    });
  }
  function assign(jobIndex, memberIndex) {
    var job = state.unassigned[jobIndex];
    var m = state.team[memberIndex];
    if (!job || !m) return;
    m.jobs = (m.jobs || 0) + 1;
    m.now = job.s + ' · ' + job.area;
    m.status = m.status && m.status.toLowerCase().indexOf('off') > -1 ? m.status : 'En route';
    m.util = Math.min(100, (m.util || 0) + 20);
    state.unassigned.splice(jobIndex, 1);
    renderTeam();
  }

  /* ---- Reports ---- */
  function renderReports() {
    var secs = (cfg.reports || []).map(function (r) {
      var chart = r.type === 'hbars' ? hbars(r.data, r.money ? money : null) : barChart(r.data, r.unit || '');
      return '<div class="oda-card"><h3>' + esc(r.title) + (r.note ? ' <span class="tag">' + esc(r.note) + '</span>' : '') + '</h3>' + chart + '</div>';
    });
    var html = (SOON.reports ? soonBar('Business reports') : '') + '<h2 class="oda-h">Reports</h2><p class="oda-sub">Where the money and the demand actually come from — so you staff and spend where it counts.</p>';
    // two per row
    html += '<div class="oda-grid2">';
    secs.forEach(function (s, i) { html += s; });
    html += '</div>';
    main.innerHTML = html;
  }

  /* ---- Payroll & analytics ---- */
  function renderPayroll() {
    var p = cfg.payroll || { rows: [] };
    var total = p.rows.reduce(function (s, r) { return s + Number(r.gross || 0); }, 0);
    var rows = p.rows.map(function (r) {
      return '<tr><td class="name"><b>' + esc(r.name) + '</b><span>' + esc(r.role) + '</span></td>' +
        '<td>' + esc(r.detail) + '</td><td class="num">' + money(r.gross) + '</td></tr>';
    }).join('');
    var an = (cfg.analytics || []).map(function (a) {
      return '<div class="oda-kpi"><div class="n">' + esc(a.n) + '</div><div class="l">' + esc(a.l) + '</div></div>';
    }).join('');

    main.innerHTML = (SOON.payroll ? soonBar('Payroll & analytics') : '') +
      '<h2 class="oda-h">Payroll & analytics</h2>' +
      '<p class="oda-sub">Hours, commissions, and the numbers behind the business — payroll runs itself off the ' + esc((T.jobs || 'jobs').toLowerCase()) + ' already in the system.</p>' +
      (state.payrollRun ? '<div class="oda-banner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>Payroll approved — ' + money(total) + ' to ' + p.rows.length + ' people, direct-deposits ' + esc(p.note || 'Friday') + '.</div>' : '') +
      '<div class="oda-card">' +
        '<h3>Pay period <span class="tag">' + esc(p.period || '') + '</span></h3>' +
        '<table class="oda-table"><thead><tr><th>' + esc(T.member || 'Person') + '</th><th>Detail</th><th style="text-align:right">Gross</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td>Total</td><td></td><td class="num">' + money(total) + '</td></tr></tfoot></table>' +
        '<div class="oda-row" style="margin:16px 0 0">' +
          '<span class="oda-sub" style="margin:0">' + (state.payrollRun ? 'Approved and scheduled.' : 'Review, then approve in one click.') + '</span>' +
          '<button class="oda-btn oda-btn-accent" id="runPayroll"' + (state.payrollRun ? ' disabled' : '') + '>' + (state.payrollRun ? 'Payroll approved' : 'Approve & run payroll') + '</button>' +
        '</div>' +
      '</div>' +
      (an ? '<div class="oda-sec"><h3 class="oda-h" style="font-size:1rem">Business analytics</h3><div class="oda-kpis">' + an + '</div></div>' : '');

    var btn = overlay.querySelector('#runPayroll');
    if (btn) btn.onclick = function () { state.payrollRun = true; renderPayroll(); };
  }

  /* ---- open / close ---- */
  function resetState() {
    state = {
      team: (cfg.team || []).map(function (m) { return Object.assign({}, m); }),
      unassigned: (cfg.unassigned || []).map(function (j) { return Object.assign({}, j); }),
      payrollRun: false
    };
  }
  window.openOwnerDash = function (levelId) {
    if (!built) build();
    resetState();
    active = 'overview';
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (LEVELS) setLevel(typeof levelId === 'string' ? levelId : (cfg.startLevel || LEVELS[0].id));
    else show('overview');
  };
  window.closeOwnerDash = function () {
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  };
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !overlay || !overlay.classList.contains('open')) return;
    var z = overlay.querySelector('.oda-zoom.open');
    if (z) z.classList.remove('open'); else closeOwnerDash();
  });
  document.addEventListener('click', function (e) {
    if (!overlay) return;
    if (!e.target.closest || !e.target.closest('.oda-assign')) {
      Array.prototype.forEach.call(overlay.querySelectorAll('.oda-menu'), function (x) { x.classList.remove('open'); });
    }
  });
})();
