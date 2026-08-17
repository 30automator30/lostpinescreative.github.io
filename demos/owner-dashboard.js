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
    { id: 'overview', label: 'Overview', icon: ICON.grid, render: renderOverview },
    { id: 'appointments', label: (T.schedule || 'Appointments'), icon: ICON.cal, render: renderAppointments },
    { id: 'team', label: (T.team || 'Team') + ' & dispatch', icon: ICON.team, render: renderTeam },
    { id: 'reports', label: 'Reports', icon: ICON.chart, render: renderReports },
    { id: 'payroll', label: 'Payroll', icon: ICON.cash, render: renderPayroll }
  ];

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
        '<span class="oda-mark">' + svg(ICON.grid) + '</span>' +
        '<span class="oda-brand"><b>' + esc(cfg.business || 'Business') + '</b><small>' + esc(cfg.label || 'Owner dashboard') + '</small></span>' +
        '<span class="oda-live"><span class="pip"></span>Live · ' + esc(cfg.today || 'Today') + '</span>' +
        '<button class="oda-close" aria-label="Close dashboard">×</button>' +
      '</div>' +
      '<div class="oda-tabs" id="odaTabs"></div>' +
      '<div class="oda-main"><div class="oda-wrap" id="odaMain"></div></div>';

    document.body.appendChild(overlay);
    main = overlay.querySelector('#odaMain');
    var tabsEl = overlay.querySelector('#odaTabs');
    TABS.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'oda-tab' + (t.id === active ? ' on' : '');
      b.setAttribute('data-tab', t.id);
      b.innerHTML = svg(t.icon) + esc(t.label);
      b.onclick = function () { show(t.id); };
      tabsEl.appendChild(b);
    });
    overlay.querySelector('.oda-close').onclick = closeOwnerDash;
    built = true;
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
        (k.d ? '<div class="d ' + (k.up ? 'up' : 'down') + '">' + (k.up ? '▲' : '▼') + ' ' + esc(k.d) + '</div>' : '') + '</div>';
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

    main.innerHTML =
      '<h2 class="oda-h">This week at a glance</h2>' +
      '<p class="oda-sub">The part your competition doesn’t have — every call, ' + esc((T.job || 'job').toLowerCase()) + ', and dollar in one place.</p>' +
      '<div class="oda-kpis">' + kpis + '</div>' +
      '<div class="oda-sec oda-grid2">' +
        '<div class="oda-card"><h3>Revenue this week <span class="tag">collected</span></h3>' + barChart(cfg.revenue || [], 'k') + '</div>' +
        '<div class="oda-card"><h3>Today’s ' + esc((T.jobs || 'jobs').toLowerCase()) + ' <span class="tag">' + appts.length + ' scheduled</span></h3>' + (snapshot || '<p class="oda-sub" style="margin:0">Nothing booked yet.</p>') + '</div>' +
      '</div>' +
      '<div class="oda-sec oda-card"><h3>' + esc(T.team || 'Team') + ' right now <span class="tag">' + onjob + ' of ' + team.length + ' active</span></h3>' +
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
  function renderAppointments() {
    var days = cfg.appointments || { today: [], tomorrow: [] };
    var list = days[apptDay] || [];
    var counts = {};
    list.forEach(function (a) { counts[a.st] = (counts[a.st] || 0) + 1; });
    main.innerHTML =
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
    main.innerHTML =
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
    var html = '<h2 class="oda-h">Reports</h2><p class="oda-sub">Where the money and the demand actually come from — so you staff and spend where it counts.</p>';
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

    main.innerHTML =
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
  window.openOwnerDash = function () {
    if (!built) build();
    resetState();
    active = 'overview';
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    show('overview');
  };
  window.closeOwnerDash = function () {
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay && overlay.classList.contains('open')) closeOwnerDash();
  });
  document.addEventListener('click', function (e) {
    if (!overlay) return;
    if (!e.target.closest || !e.target.closest('.oda-assign')) {
      Array.prototype.forEach.call(overlay.querySelectorAll('.oda-menu'), function (x) { x.classList.remove('open'); });
    }
  });
})();
