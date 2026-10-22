/* IFC 2026 feedback dashboard
 *
 * Reads everything from the Google Apps Script (action "dashboard"), which checks
 * the password on Google's side. Questions come from ../config.js, so the
 * dashboard always matches the form. Refreshes every minute while open.
 */
(function () {
  'use strict';

  var CFG = window.IFC_CONFIG || {};
  var API = (CFG.apiUrl || '').trim();
  var TZ = CFG.timezone || 'Europe/Amsterdam';
  var KEY_STORE = 'ifc26-dash-key';
  var REFRESH_MS = 60 * 1000;

  var Q = CFG.questions || [];
  // star questions; the per-speaker question counts via its average column
  var RATINGS = Q.filter(function (q) { return q.type === 'rating' || q.type === 'speakers'; });
  var SPEAKERQ = Q.filter(function (q) { return q.type === 'speakers'; })[0] || null;
  var CHOICES = Q.filter(function (q) { return q.type === 'choice'; });
  var TEXTS = Q.filter(function (q) { return q.type === 'text'; });
  var col = function (q) { return q.column || q.label; };
  var OVERALL = RATINGS[0] ? col(RATINGS[0]) : null;
  var PRACTICE = CHOICES[0] || null;          // the yes/no-style question (now "Did you learn anything new?")
  var PRACTICE_SHORT = PRACTICE ? col(PRACTICE) : '';
  // Session leader form
  var LQ = CFG.leaderQuestions || [];
  var L_NAME = LQ.filter(function (q) { return q.type === 'name'; }).map(col)[0];
  var L_RATINGS = LQ.filter(function (q) { return q.type === 'rating'; });
  var L_TAKEAWAY = LQ.filter(function (q) { return /takeaway/i.test(col(q)); }).map(col)[0];   // "Key takeaway" (download on the Session Leaders tab)
  var L_TEXTS = LQ.filter(function (q) { return q.type === 'text'; });
  var L_ISSUES = L_TEXTS[0] ? col(L_TEXTS[0]) : null;          // "Key issues"
  var L_OVERALL = L_RATINGS[0] ? col(L_RATINGS[0]) : null;
  // The Session Leaders and Advisory Panel tabs work the same way: one description of each
  function reportGroup(qs, o) {
    var texts = qs.filter(function (q) { return q.type === 'text'; }), ratings = qs.filter(function (q) { return q.type === 'rating'; });
    o.nameCol = qs.filter(function (q) { return q.type === 'name'; }).map(col)[0];
    o.ratings = ratings; o.texts = texts;
    o.issues = texts[0] ? col(texts[0]) : null;                  // "Key issues"
    o.overall = ratings[0] ? col(ratings[0]) : null;
    o.sortBy = 'sent'; o.sortDir = -1; o.filterVal = ''; o.ownerFilter = '';   // ownerFilter: '' all, '-' unassigned, or a name          // newest report first
    return o;
  }
  var LG = reportGroup(LQ, { tab: 'leaders', kind: 'leader', count: 'issueCount', filter: 'lFilter',
    who: 'Session Leader', all: 'All Session Leaders', reports: 'Session Leader reports', form: '/sessionleader' });
  var PG = reportGroup(CFG.panelQuestions || [], { tab: 'panel', kind: 'panel', count: 'panelCount', filter: 'pFilter',
    who: 'Panel member', all: 'Whole panel', reports: 'Advisory Panel reports', form: '/panel' });

  var OWNERS = CFG.issueOwners || ['Shawn', 'Advisory Panel', 'RA'];
  var $ = function (id) { return document.getElementById(id); };
  var ANALYTICS = true;    // last tab: how people use the tool (not front and centre)
  var state = {
    key: null, data: null, lastOk: 0, tab: 'overview',
    sortBy: 'rank', sortDir: 1, minN: 1, scorecard: '', commentsShown: 100,
    picked: [], withLeaders: true, withPanel: true
  };
  var sessions = [], byId = {}, rows = [], leaders = [], panel = [];


  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function store(area, key, val) {
    try {
      var st = area === 'local' ? localStorage : sessionStorage;
      if (val === undefined) return st.getItem(key);
      if (val === null) st.removeItem(key); else st.setItem(key, val);
    } catch (e) { return null; }
  }
  // Last results kept on this device, so the dashboard shows something instantly while Google
  // (5-10 seconds) sends fresh numbers. One copy for real responses, one for test. Cleared on sign out.
  function cacheKey() { return 'ifc26-dash-cache-' + ($('showTest').checked ? 'test' : 'real'); }
  function saveCache(d) { try { localStorage.setItem(cacheKey(), JSON.stringify({ t: Date.now(), d: d })); } catch (e) { /* full or blocked: fine */ } }
  function readCache() { try { return JSON.parse(localStorage.getItem(cacheKey()) || 'null'); } catch (e) { return null; } }
  // (the half-hour bit: the Outstanding reports count also changes when a new time slot starts)
  function signature(d) { return JSON.stringify([d.sessions, d.responses, d.leaders, d.panel, d.allocations, d.cleared, d.events, Math.floor(nowMin() / 30)]); }

  // Redraw only when the numbers changed, and never under someone's fingers (an open dropdown, a half-typed note)
  var pendingRender = false;
  function busyTyping() {
    var a = document.activeElement;
    return a && a.closest && a.closest('.panel') && /^(SELECT|TEXTAREA|INPUT)$/.test(a.tagName);
  }
  function show(d) {
    var sig = signature(d);
    state.data = d;
    if (sig === state.sig) return;
    state.sig = sig;
    prepare();
    if (busyTyping()) { pendingRender = true; return; }
    renderAll();
  }
  // Saved results older than this aren't shown (they'd look like real numbers but be well out of date,
  // e.g. all zeros from before the day started): "Loading the latest results" shows instead
  var CACHE_MAX_AGE = 10 * 60 * 1000;
  function showCached() {
    var c = readCache();
    if (!c || !c.d || Date.now() - c.t > CACHE_MAX_AGE) { loadingPanels(); return false; }
    state.cachedAt = c.t;
    show(c.d);
    return true;
  }

  function num(v) { var n = Number(v); return v === '' || v == null || isNaN(n) ? null : n; }
  function mean(list) { return list.length ? list.reduce(function (a, b) { return a + b; }, 0) / list.length : null; }
  function fmt1(n) { return n == null ? '–' : n.toFixed(1); }
  function pct(a, b) { return b ? Math.round(100 * a / b) + '%' : '–'; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayLabel(d) {
    if (!d) return '';
    var p = d.split('-'), dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return DAYS[dt.getUTCDay()] + ' ' + (+p[2]) + ' ' + MONTHS[+p[1] - 1];
  }
  function localTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
    } catch (e) { return d.toLocaleString(); }
  }
  function ago(ms) {
    var m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
  }
  function starsText(n) {
    n = Math.round(n || 0);
    return n ? '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n) : '';
  }


  /* ---------- loading ---------- */

  // Every request gets a number; only the answer to the newest one is used. Otherwise a
  // slow "real data" refresh arriving after a "test data" one would overwrite it.
  var reqSeq = 0;
  // A random id for this browser tab, so the server can count how many dashboards are open (anonymous)
  function viewerId() {
    var v = store('session', 'ifc26-viewer');
    if (!v) { v = Math.random().toString(36).slice(2, 12); store('session', 'ifc26-viewer', v); }
    return v;
  }

  function fetchData() {
    var mine = ++reqSeq, wantTest = $('showTest').checked;
    return fetch(API, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'dashboard', key: state.key, test: wantTest, viewer: viewerId() })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (mine !== reqSeq || wantTest !== $('showTest').checked) { d = { ok: true, stale: true }; }
      return d;
    });
  }

  var quickRetry = 0, quickTimer = null;
  function load() {
    $('updated').textContent = !state.lastOk && state.cachedAt
      ? 'Showing results from ' + ago(Date.now() - state.cachedAt) + ' · updating…' : 'Updating…';
    clearTimeout(quickTimer);
    return fetchData().then(function (d) {
      if (d.stale) return;                      // a newer request is on its way; ignore this answer
      if (!d.ok) {
        if (d.error === 'wrong password' || d.error === 'locked' || d.error === 'no password') {
          signOut(coded(d.message || 'That password did not work.', d.code));
        } else showAlert(coded('The database answered with an error: ' + (d.message || d.error) + '. Showing the last data received.', 'D102', d.code));
        return;
      }
      state.lastOk = Date.now(); state.cachedAt = null; quickRetry = 0;
      showAlert(healthMessage(d.health));
      show(d);
      saveCache(d);
    }).catch(function () {
      // Blips happen (Google occasionally drops a request): retry quickly twice before worrying anyone
      if (quickRetry < 2) {
        quickRetry++;
        $('updated').textContent = 'Retrying…';
        quickTimer = setTimeout(load, quickRetry === 1 ? 5000 : 15000);
        return;
      }
      quickRetry = 0;
      showAlert(coded('Could not reach the database (tried 3 times). Will keep trying every minute' +
        (state.data ? '; showing the last data received.' : '.') + ' Responses are still being saved.', 'D101'));
    }).then(updateStatus);
  }

  function prepare() {
    sessions = (state.data.sessions || []).map(function (s) {
      return {
        id: String(s.ID || s.Id || s.id || ''), title: s.Title || '', speakers: s.Speakers || '',
        room: s.Room || '', date: s.Date || '', start: s.Start || '', end: s.End || '',
        track: s.Track || '', type: s.Type || '', attendance: num(s.Attendance || s.Attendees || '')
      };
    }).filter(function (s) { return s.title; });
    byId = {};
    sessions.forEach(function (s) { byId[s.id] = s; });

    rows = (state.data.responses || []).filter(function (r) { return r['Came from'] !== 'Load test'; })   // tools/load_test.py rows: never shown
      .map(function (r) {
      var id = String(r['Session ID'] || '');
      var s = byId[id];
      var t = String(r.Time || '').split(/[–-]/);
      return {
        raw: r, row: r._row, id: id, typed: id === 'NOT LISTED', when: r.Timestamp,
        title: s ? s.title : r.Session || '', speakers: s ? s.speakers : r.Speakers || '',
        room: s ? s.room : r.Room || '', date: s ? s.date : String(r.Date || '').slice(0, 10),
        start: s ? s.start : (t[0] || '').trim(), track: s ? s.track : r.Track || '', type: s ? s.type : '',
        source: r['Came from'] || 'Unknown',
        contact: r['Contact me'] === 'Yes', contactName: r['Contact name'] || '', contactEmail: r['Contact email'] || '',
        online: r.Format === 'Online'                // from the IFC Online form (/online)
      };
    });
    leaders = reportsFrom(state.data.leaders, L_NAME);
    panel = reportsFrom(state.data.panel, PG.nameCol);
    fillFilters();
  }

  // Masterclass part 1 (Tuesday) reports carry the masterclass ID plus "-P1" (Session Leader and panel forms only)
  function baseId(id) { return String(id).replace(/-P1$/, ''); }
  function sameSession(l, s) { return baseId(l.id) === s.id; }

  // Session Leader or Advisory Panel reports from the Sheet, latest version of each
  function reportsFrom(raw, nameCol) {
    var list = (raw || []).map(function (r) {
      var id = String(r['Session ID'] || ''), s = byId[id];
      return {
        raw: r, row: r._row, id: id, when: r.Timestamp, name: r[nameCol] || '',
        owner: String(r['Issue owner'] || ''),
        handled: String(r['Issue status'] || '').indexOf('Handled') === 0, handledNote: r['Issue note'] || '', handledWhen: String(r['Issue status'] || '').replace('Handled ', ''),
        title: s ? s.title : r.Session || '', speakers: s ? s.speakers : r.Speakers || '',
        room: s ? s.room : r.Room || '', date: s ? s.date : String(r.Date || '').slice(0, 10),
        start: s ? s.start : String(r.Time || '').split(/[–-]/)[0].trim(), track: s ? s.track : r.Track || '', type: s ? s.type : ''
      };
    });
    // Someone who updates a report sends it again: show only their latest one per session
    var latest = {};
    list.forEach(function (l) {
      var k = String(l.name).trim().toLowerCase() + '|' + l.id, cur = latest[k];
      l.versions = 1;
      if (!cur) { latest[k] = l; return; }
      var newer = String(l.when) > String(cur.when) ? l : cur;
      newer.versions = cur.versions + 1;
      latest[k] = newer;
    });
    return list.filter(function (l) { return l.id === 'NOT LISTED' || latest[String(l.name).trim().toLowerCase() + '|' + l.id] === l; });
  }

  function fillFilters() {
    var setOpts = function (sel, values, label) {
      var cur = sel.value;
      sel.innerHTML = '<option value="">' + label + '</option>' + values.map(function (v) {
        return '<option value="' + esc(v[0]) + '">' + esc(v[1]) + '</option>';
      }).join('');
      sel.value = values.some(function (v) { return v[0] === cur; }) ? cur : '';
    };
    var uniq = function (list) { return list.filter(function (v, i, a) { return v && a.indexOf(v) === i; }).sort(); };
    // Each day, then its time slots indented under it ("2026-10-21" = the whole day, "2026-10-21 15:30" = one slot)
    var dayOpts = [];
    uniq(sessions.map(function (s) { return s.date; })).forEach(function (d) {
      dayOpts.push([d, dayLabel(d)]);
      uniq(sessions.filter(function (s) { return s.date === d; }).map(function (s) { return s.start; })).forEach(function (t) {
        dayOpts.push([d + ' ' + t, '\u00a0\u00a0\u00a0\u00a0\u2022 ' + dayLabel(d).split(' ')[0] + ' ' + t]);
      });
    });
    setOpts($('fDay'), dayOpts, 'All days');
    setOpts($('fType'), uniq(sessions.map(function (s) { return s.type; })).map(function (v) { return [v, v]; }), 'All types');
    // Tracks only: names that are really types (Masterclasses, Keynote) live in the Type filter
    var types = uniq(sessions.map(function (s) { return s.type; }));
    setOpts($('fTrack'), uniq(sessions.map(function (s) { return s.track; })).filter(function (v) { return types.indexOf(v) === -1; })
      .map(function (v) { return [v, v]; }), 'All tracks');
    setOpts($('fRoom'), uniq(sessions.map(function (s) { return s.room.split(' (')[0]; }))
      .sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); }).map(function (v) { return [v, v]; }), 'All rooms');
  }


  /* ---------- filtering ---------- */

  function matches(x, withText) {
    var day = $('fDay').value, ty = $('fType').value, tr = $('fTrack').value, room = $('fRoom').value;
    var text = $('fText').value.trim().toLowerCase();
    if (day && x.date !== day.split(' ')[0]) return false;
    if (day && day.split(' ')[1] && x.start !== day.split(' ')[1]) return false;     // one time slot
    if (ty && x.type !== ty) return false;
    if (tr && x.track !== tr) return false;
    if (room && x.room.split(' (')[0] !== room) return false;
    if (text && withText !== false) {
      var hay = (x.title + ' ' + x.speakers + ' ' + x.room + ' ' + (withText || '')).toLowerCase();
      if (hay.indexOf(text) === -1) return false;
    }
    return true;
  }
  function commentText(r) { return TEXTS.map(function (q) { return r.raw[col(q)] || ''; }).join(' '); }
  // In-person feedback only, unless "Include online reviews" is ticked (IFC Online has its own tab)
  function fRows() { return rows.filter(function (r) { return (state.withOnline || !r.online) && matches(r, commentText(r)); }); }
  function fSessions() { return sessions.filter(function (s) { return matches(s); }); }

  function statsFor(list) {
    var o = { n: list.length, avgs: [], practiceYes: 0, practiceN: 0 };
    RATINGS.forEach(function (q) {
      o.avgs.push(mean(list.map(function (r) { return num(r.raw[col(q)]); }).filter(function (v) { return v != null; })));
    });
    if (PRACTICE) {
      list.forEach(function (r) {
        var v = r.raw[col(PRACTICE)];
        if (v) { o.practiceN++; if (v === PRACTICE.options[0]) o.practiceYes++; }
      });
    }
    return o;
  }


  /* ---------- overview ---------- */

  function renderOverview() {
    var list = fRows(), real = list.filter(function (r) { return !r.typed; });
    var st = statsFor(list), ses = fSessions();
    var rated = {}; real.forEach(function (r) { rated[r.id] = 1; });
    var ratedN = ses.filter(function (s) { return rated[s.id]; }).length;
    var last = list.reduce(function (m, r) { var t = Date.parse(r.when); return t > m ? t : m; }, 0);

    var html = '<div class="tiles">' +
      tile('Responses', list.length.toLocaleString(), last ? 'Last one ' + localTime(new Date(last).toISOString()) + (Date.now() >= last ? ' (' + ago(Date.now() - last) + ')' : '') : 'None yet') +
      tile('Sessions with feedback', ratedN + ' <small>of ' + ses.length + '</small>', pct(ratedN, ses.length) + ' of sessions') +
      tile('Average overall', st.avgs[0] == null ? '–' : fmt1(st.avgs[0]) + ' <small>/ 5</small>', 'From ' + list.filter(function (r) { return num(r.raw[OVERALL]) != null; }).length + ' ratings') +
      (PRACTICE ? tile(PRACTICE_SHORT, pct(st.practiceYes, st.practiceN), 'said “' + esc(PRACTICE.options[0]) + '”, of ' + st.practiceN + ' who answered') : '') +
      '</div>';

    // responses per time block
    var blocks = {}, order = [];
    ses.forEach(function (s) {
      var k = s.date + ' ' + s.start;
      if (!blocks[k]) { blocks[k] = { date: s.date, start: s.start, n: 0, sessions: 0 }; order.push(k); }
      blocks[k].sessions++;
    });
    list.forEach(function (r) { var k = r.date + ' ' + r.start; if (blocks[k]) blocks[k].n++; });
    order.sort();
    // Two columns on a computer: responses per time block | open key issues (stacked on phones)
    html += '<div class="ov-cols"><div class="ov-main">' +
      '<h2 class="section">Responses per time block</h2><p class="sub">Each bar is one time slot.<span class="desk-only"> Hover for details.</span></p>' +
      columnChart(order.map(function (k) { return blocks[k]; })) + barList(order.map(function (k) { return blocks[k]; })) +
      '<button type="button" class="link table-toggle" data-toggle="blockTable">Show as a table</button>' +
      '<div id="blockTable" hidden>' + blockTable(order.map(function (k) { return blocks[k]; })) + '</div></div>' +
      '<aside class="ov-issues">' + issuesSummary() + '</aside></div>';
    $('tab-overview').innerHTML = html;
  }

  // Overview: how many open key issues each owner has, Session Leaders and Advisory Panel. Each number opens that
  // tab filtered to those issues. Follows the filters above.
  function issuesSummary() {
    var groups = [[LG, leaders, 'leaders', 'Session Leaders'], [PG, panel, 'panel', 'Advisory Panel']].map(function (g) {
      var open = g[1].filter(function (l) {
        return g[0].issues && !l.handled && String(l.raw[g[0].issues] || '').trim() && matches(l, l.name + ' ' + l.raw[g[0].issues]);
      });
      return { tab: g[2], label: g[3], open: open };
    });
    var n = function (g, o) { return g.open.filter(function (l) { return o === '' ? true : o === '-' ? !l.owner : l.owner === o; }).length; };
    var cell = function (g, o) {
      var c = n(g, o);
      return '<td class="num">' + (c ? '<button type="button" class="ov-num" data-ovtab="' + g.tab + '" data-ovowner="' + esc(o) + '" title="Show these key issues">' + c + '</button>'
                                     : '<span class="ov-zero">0</span>') + '</td>';
    };
    var total = groups.reduce(function (t, g) { return t + g.open.length; }, 0);
    var rowsHtml = [['-', 'Unassigned']].concat(OWNERS.map(function (o) { return [o, o]; })).concat([['', 'All open']]).map(function (o) {
      return '<tr' + (o[0] === '' ? ' class="ov-total"' : '') + '><th scope="row">' + esc(o[1]) + '</th>' + groups.map(function (g) { return cell(g, o[0]); }).join('') + '</tr>';
    }).join('');
    return '<h2 class="section">Open key issues <span class="count' + (total ? ' warn' : ' zero') + '">' + total + '</span></h2>' +
      '<p class="sub">By who they\'re assigned to. Click a number to see those key issues.</p>' +
      '<table class="ov-table"><thead><tr><th></th>' + groups.map(function (g) { return '<th class="num">' + esc(g.label) + '</th>'; }).join('') + '</tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody></table>';
  }

  // Minutes between a session's end (conference local time) and when the response arrived.
  // Negative = sent before the session ended.
  function wallMinutes(iso) {
    var dt = new Date(iso);
    if (isNaN(dt)) return null;
    try {
      var p = {};
      new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(dt).forEach(function (x) { p[x.type] = x.value; });
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 60000;
    } catch (e) { return null; }
  }
  function delayOf(r, endTime) {
    if (!r.date || !endTime) return null;
    var w = wallMinutes(r.when);
    if (w == null) return null;
    var d = r.date.split('-'), t = endTime.split(':');
    return w - Date.UTC(+d[0], +d[1] - 1, +d[2], +t[0], +t[1]) / 60000;
  }
  function median(list) {
    if (!list.length) return null;
    var s = list.slice().sort(function (a, b) { return a - b; }), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function fmtDelay(m) {
    if (m == null) return '–';
    var a = Math.abs(Math.round(m)), txt = a < 60 ? a + ' min' : (a < 1440 ? Math.floor(a / 60) + ' h ' + (a % 60 ? a % 60 + ' min' : '') : Math.round(a / 1440) + ' days');
    return (m < 0 ? txt.trim() + ' before the end' : txt.trim() + ' after');
  }
  var DELAY_BUCKETS = [
    ['Before it ended', -Infinity, 0], ['0–5 min after', 0, 5], ['5–15 min', 5, 15], ['15–30 min', 15, 30],
    ['30–60 min', 30, 60], ['1–2 hours', 60, 120], ['2–6 hours', 120, 360], ['Later', 360, Infinity]];

  function timingSection(list, label) {
    var delays = list.map(function (r) {
      var s = byId[r.id];
      return delayOf(r, s ? s.end || s.start : null);
    }).filter(function (v) { return v != null; });
    if (!delays.length) return '<p class="empty">No ' + label + ' with a session time yet.</p>';
    var before = delays.filter(function (v) { return v < 0; }).length;
    var counts = DELAY_BUCKETS.map(function (b) { return delays.filter(function (v) { return v >= b[1] && v < b[2]; }).length; });
    var mx = Math.max.apply(null, counts.concat(1));
    return '<div class="tiles">' +
      tile('Median', fmtDelay(median(delays)), 'Half of ' + label + ' came in sooner than this') +
      tile('Average', fmtDelay(mean(delays)), 'Very late responses pull this up') +
      tile('Before the session ended', String(before), pct(before, delays.length) + ' of ' + delays.length) +
      tile('After it ended', String(delays.length - before), pct(delays.length - before, delays.length) + ' of ' + delays.length) +
      '</div><div class="dist timing" role="img" aria-label="How soon after the session ' + label + ' came in">' +
      DELAY_BUCKETS.map(function (b, i) {
        return '<span>' + esc(b[0]) + '</span><span class="b" data-tip="' + esc(b[0] + ': ' + counts[i] + ' ' + label + ' (' + pct(counts[i], delays.length) + ')') + '">' +
          '<i style="width:' + (counts[i] / mx * 100) + '%"></i></span><span class="n">' + counts[i] + '</span>';
      }).join('') + '</div>';
  }

  // Visits, picks, how sessions were found and the per-phone code started being counted at this moment
  var STATS_FROM = '2026-10-21T14:19:00.000Z';          // UTC
  function statsFromLabel() { return 'Wed 21 Oct, 16:19'; }
  var FOUND_VIA = ['Room sign', 'Just finished list', 'In progress list', 'Search', 'Browse', 'Typed in', 'Suggested (online)'];

  // Analytics: how people use the tool (for Shawn)
  function renderAnalytics() {
    if (!ANALYTICS) return;
    var list = fRows(), src = {};
    list.forEach(function (r) { src[r.source] = (src[r.source] || 0) + 1; });
    var ev = state.data.events || {}, u = (state.data.health || {}).usage || {};
    var html = '<h2 class="section">How people got to the form</h2><p class="sub">Per response, with the filters above applied. Taps, scans and link opens are every time it happened, sent or not (not filtered; NFC taps and QR scans counted since Thu 22 Oct, 10:12).</p><div class="tiles">' +
      ['QR code', 'NFC tag', 'Event app', 'Link', 'Home screen'].map(function (k) {
        return tile(k, String(src[k] || 0), pct(src[k] || 0, list.length) + ' of responses' +
          (k === 'Event app' ? ' \u00b7 link opened ' + (ev['open-eventapp'] || 0) + ' times'
            : k === 'NFC tag' ? ' \u00b7 tags tapped ' + (ev['open-nfc'] || 0) + ' times'
            : k === 'QR code' ? ' \u00b7 scanned ' + (ev['open-qr'] || 0) + ' times' : ''));
      }).join('') + '</div>' +
      // Opened -> picked a session -> sent (all responses, not filtered: the open and pick counts can't be)
      (function () {
        var since = rows.filter(function (r) { return String(r.when) >= STATS_FROM; }).length;
        var picks = ev.chose || 0, gaveUp = Math.max(0, picks - since);
        return '<h2 class="section">From opening the form to sending</h2><p class="sub">Counted since ' + esc(statsFromLabel()) +
          '. Not filtered. A visit is one person opening the form (a reload doesn\'t count again); one visit can rate several sessions.</p><div class="tiles">' +
          tile('Visits', String(ev.open || 0), 'Times the form was opened') +
          tile('Picked a session', String(picks), 'Opened a session\'s questions') +
          tile('Sent', String(since), pct(since, picks) + ' of sessions picked') +
          tile('Picked but didn\u2019t send', String(gaveUp), pct(gaveUp, picks) + ' of sessions picked (includes going back to pick another)') + '</div>';
      })() +
      // How people found their session (responses since STATS_FROM carry "Found via")
      (function () {
        var withVia = list.filter(function (r) { return r.raw['Found via']; }), c = {};
        withVia.forEach(function (r) { c[r.raw['Found via']] = (c[r.raw['Found via']] || 0) + 1; });
        return '<h2 class="section">How people found their session</h2><p class="sub">Responses since ' + esc(statsFromLabel()) + ' (' + withVia.length +
          '), with the filters above applied.</p><div class="tiles">' +
          FOUND_VIA.filter(function (k) { return k !== 'Suggested (online)' || c[k]; }).map(function (k) {
            return tile(k, String(c[k] || 0), pct(c[k] || 0, withVia.length));
          }).join('') + '</div>';
      })() +
      // How many different people (an anonymous random code per phone), and written comments
      (function () {
        var withDev = list.filter(function (r) { return r.raw.Device; }), per = {};
        withDev.forEach(function (r) { per[r.raw.Device] = (per[r.raw.Device] || 0) + 1; });
        var people = Object.keys(per).length, most = people ? Math.max.apply(null, Object.keys(per).map(function (k) { return per[k]; })) : 0;
        var commented = list.filter(function (r) { return commentText(r).trim(); }).length;
        return '<h2 class="section">People and comments</h2><p class="sub">People are counted from an anonymous code on each phone, for responses since ' +
          esc(statsFromLabel()) + ' (' + withDev.length + '). With the filters above applied.</p><div class="tiles">' +
          tile('People who gave feedback', String(people), withDev.length + ' responses between them') +
          tile('Sessions per person', people ? (withDev.length / people).toFixed(1) : '\u2013', 'Average') +
          tile('Most by one person', String(most), most === 1 ? 'session' : 'sessions') +
          tile('Left a written comment', String(commented), pct(commented, list.length) + ' of all responses') + '</div>';
      })() +
      // Optional contact details ("open to the IFC team following up"): who left a name
      (function () {
        var named = list.filter(function (r) { return String(r.contactName || '').trim(); }).length;
        return '<h2 class="section">Contact details</h2><p class="sub">People who ticked that they\'re open to the IFC team following up and left their name. Per response, with the filters above applied.</p><div class="tiles">' +
          tile('Left their name', String(named), pct(named, list.length) + ' of responses') +
          tile('Didn\u2019t leave a name', String(list.length - named), pct(list.length - named, list.length) + ' of responses') + '</div>';
      })() +
      '<h2 class="section">Clicks and installs</h2><p class="sub">Anonymous counts (not filtered). Installs can only be counted on Android; ' +
      'iPhones show up as "Home screen" responses instead.</p><div class="tiles">' +
      tile('End-of-conference form clicks', String(ev['overall-click'] || 0), 'Taps on \u201cGive feedback on IFC 2026\u201d (from Friday)') +
      tile('“Contact us” clicks', String(ev.help || 0), 'People who tapped the help link') +
      tile('ShawnLife clicks', String(ev.shawnlife || 0), 'Footer credit link') +
      tile('Saw the home-screen tip', String(ev['tip-shown'] || 0), 'Shown on the thank-you screen') +
      tile('Added to home screen', String(ev.installed || 0), 'Android installs') +
      '</div>' +
      '<h2 class="section">Review timing</h2><p class="sub">How long after each session ended people sent their feedback (conference time). With the filters above applied.</p>' +
      timingSection(list.filter(function (r) { return !r.typed; }), 'responses') +
      '<h2 class="section">Google limits today</h2><p class="sub">Free-plan daily allowances. An email goes to Shawn well before either runs out.</p><div class="tiles">' +
      tile('Background script time', (u.runMinutes == null ? '–' : u.runMinutes) + ' <small>of 90 min</small>', 'Resets daily') +
      tile('Firebase reads', (u.firebaseReads == null ? '–' : u.firebaseReads.toLocaleString()) + ' <small>of 50,000</small>', 'Resets 09:00 Netherlands time') +
      '</div>';
    $('tab-analytics').innerHTML = html;
  }

  function tile(label, value, note) {
    return '<div class="tile"><div class="label">' + esc(label) + '</div>' +
      (value !== '' ? '<div class="value">' + value + '</div>' : '') +
      '<div class="note">' + note + '</div></div>';
  }

  function columnChart(data) {
    if (!data.length) return '<p class="empty">No sessions match these filters.</p>';
    var max = Math.max(1, Math.max.apply(null, data.map(function (d) { return d.n; })));
    var step = Math.ceil(max / 4 / 5) * 5 || 1, top = step * 4;
    var slot = 44, left = 40, h = 220, bottom = 44, w = left + data.length * slot;
    var y = function (v) { return 22 + (h - 22) * (1 - v / top); };   // room above the tallest bar for its label
    // drawn at its natural size (never stretched), scrolls sideways on small screens
    var svg = '<svg width="' + w + '" height="' + (h + bottom) + '" viewBox="0 0 ' + w + ' ' + (h + bottom) + '" role="img" aria-label="Responses per time block">';
    for (var g = 0; g <= 4; g++) {
      var gy = y(step * g);
      svg += '<line class="grid" x1="' + left + '" x2="' + w + '" y1="' + gy + '" y2="' + gy + '"/>' +
        '<text class="axis-label" x="' + (left - 6) + '" y="' + (gy + 4) + '" text-anchor="end">' + (step * g) + '</text>';
    }
    var prevDay = '';
    data.forEach(function (d, i) {
      var x = left + i * slot + (slot - 22) / 2, bh = h - y(d.n), by = y(d.n);
      var tipTxt = dayLabel(d.date) + ', ' + d.start + '<br>' + d.n + ' responses from ' + d.sessions + ' sessions';
      svg += '<rect class="hit" x="' + (left + i * slot) + '" y="0" width="' + slot + '" height="' + h + '" data-tip="' + esc(tipTxt) + '"/>';
      if (d.n) svg += '<path class="bar" d="M' + x + ',' + h + 'V' + (by + 4) + 'q0,-4 4,-4h14q4,0 4,4V' + h + 'Z" pointer-events="none"/>';
      if (d.n === max && d.n) svg += '<text class="value-label" x="' + (x + 11) + '" y="' + (by - 6) + '" text-anchor="middle">' + d.n + '</text>';
      svg += '<text class="axis-label" x="' + (x + 11) + '" y="' + (h + 16) + '" text-anchor="middle">' + esc(d.start) + '</text>';
      if (d.date !== prevDay) svg += '<text class="axis-label" x="' + (left + i * slot + 4) + '" y="' + (h + 34) + '" font-weight="700">' + esc(dayLabel(d.date).split(' ')[0]) + '</text>';
      prevDay = d.date;
    });
    return '<div class="chart" id="blockChart">' + svg + '</svg></div>';
  }

  // Phones: one row per time slot (day, time, bar, number) instead of the wide chart
  function barList(data) {
    if (!data.length) return '';
    var max = Math.max(1, Math.max.apply(null, data.map(function (d) { return d.n; }))), day = '';
    return '<div class="bar-list" aria-hidden="true">' + data.map(function (d) {
      var head = d.date !== day ? '<div class="bl-day">' + esc(dayLabel(d.date)) + '</div>' : '';
      day = d.date;
      return head + '<div class="bl-row"><span class="bl-time">' + esc(d.start) + '</span>' +
        '<span class="bl-track"><i style="width:' + (d.n ? Math.max(2, Math.round(100 * d.n / max)) : 0) + '%"></i></span>' +
        '<span class="bl-n">' + d.n + '</span></div>';
    }).join('') + '</div>';
  }

  function blockTable(data) {
    return '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Day</th><th>Time</th><th class="num">Sessions</th><th class="num">Responses</th></tr></thead><tbody>' +
      data.map(function (d) {
        return '<tr><td>' + esc(dayLabel(d.date)) + '</td><td>' + esc(d.start) + '</td><td class="num">' + d.sessions + '</td><td class="num">' + d.n + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }


  /* ---------- rankings ---------- */

  function rankingData() {
    var list = fRows(), groups = {};
    list.forEach(function (r) { if (!r.typed) (groups[r.id] = groups[r.id] || []).push(r); });
    if (state.combine) {                       // one row per workshop, all its runs together
      return workshopsOf(fSessions()).map(function (w) {
        var g = [], lr = [];
        w.runs.forEach(function (s) {
          g = g.concat(groups[s.id] || []);
          leaders.forEach(function (l) { if (sameSession(l, s) && num(l.raw[L_OVERALL]) != null) lr.push(num(l.raw[L_OVERALL])); });
        });
        var first = w.runs[0];
        var s = { id: first.id, title: w.title, speakers: w.speakers, date: first.date, start: first.start, track: first.track,
                  room: w.runs.length > 1 ? w.runs.length + ' runs' : first.room, runs: w.runs.length };
        return { s: s, st: statsFor(g), rate: null, leader: lr.length ? Math.max.apply(null, lr) : null, leaderAll: lr, runs: w.runs };
      });
    }
    return fSessions().map(function (s) {
      var g = groups[s.id] || [], st = statsFor(g);
      var lr = leaders.filter(function (l) { return sameSession(l, s); }).map(function (l) { return num(l.raw[L_OVERALL]); })
        .filter(function (v) { return v != null; });
      // each leader's own score (never averaged, so disagreement stays visible); sorting uses the highest
      return { s: s, st: st, rate: s.attendance ? st.n / s.attendance : null, leader: lr.length ? Math.max.apply(null, lr) : null, leaderAll: lr, runs: [s] };
    });
  }

  // Rank = best overall score (as shown, one decimal), then more responses. Same score AND same
  // number of responses = tied. The rank stays with the session whatever column is sorted.
  function rankAll(data) {
    var ok = data.filter(function (d) { return d.st.n >= state.minN && d.st.avgs[0] != null; });
    var score = function (d) { return Math.round(d.st.avgs[0] * 10) / 10; };
    ok.sort(function (a, b) { return score(b) - score(a) || b.st.n - a.st.n; });
    ok.forEach(function (d, i) {
      var prev = ok[i - 1];
      d.rank = prev && score(prev) === score(d) && prev.st.n === d.st.n ? prev.rank : i + 1;
    });
    ok.forEach(function (d) { d.tied = ok.filter(function (x) { return x.rank === d.rank; }).length > 1; });
    data.forEach(function (d) { if (ok.indexOf(d) === -1) { d.rank = null; d.tied = false; } });
    return ok;
  }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  // One setting, shown on Session rankings and Scorecards: adds IFC Online feedback to the in-person numbers
  function onlineToggle() {
    return '<label class="toggle"><input type="checkbox" class="withOnline"' + (state.withOnline ? ' checked' : '') + '> Include online reviews</label>';
  }

  function renderRankings() {
    var data = rankingData();
    rankAll(data);
    var hasRate = data.some(function (d) { return d.rate != null; });
    var shown = data.filter(function (d) { return d.st.n >= state.minN; });
    var key = state.sortBy, dir = state.sortDir;
    var val = function (d) {
      if (key === 'rank') return d.rank == null ? 1e9 : d.rank;
      if (key === 'n') return d.st.n;
      if (key === 'rate') return d.rate == null ? -1 : d.rate;
      if (key === 'practice') return d.st.practiceN ? d.st.practiceYes / d.st.practiceN : -1;
      if (key === 'when') return d.s.date + d.s.start + d.s.room;
      if (key === 'leader') return d.leader == null ? -1 : d.leader;
      if (key === 'title') return d.s.title.toLowerCase();
      var i = +key.slice(3); return d.st.avgs[i] == null ? -1 : d.st.avgs[i];
    };
    shown.sort(function (a, b) {
      var va = val(a), vb = val(b);
      return (va > vb ? 1 : va < vb ? -1 : 0) * dir || b.st.n - a.st.n;
    });
    var th = function (k, label, numCol) {
      var sorted = key === k ? ' aria-sort="' + (dir > 0 ? 'ascending' : 'descending') + '"' : '';
      return '<th class="' + (numCol ? 'num' : '') + '"><button type="button" data-sort="' + k + '"' + sorted + '>' + label + '</button></th>';
    };
    var html = '<div class="controls">' +
      '<label class="toggle"><input type="checkbox" id="combine"' + (state.combine ? ' checked' : '') + '> Combine repeated workshops</label>' +
      onlineToggle() +
      '<span class="few">' + shown.length + ' of ' + data.length + ' sessions have feedback. Scores from only a few people are less reliable.</span>' +
      '<span class="spacer"></span><button type="button" class="secondary small" id="exportBtn">Download ranking (Excel)</button></div>';
    html += '<div class="tbl-wrap"><table class="tbl"><thead><tr>' + th('rank', 'Rank', 1) + th('title', 'Session') + th('when', state.combine ? 'When / runs' : 'When / room') + th('n', 'Responses', 1) +
      (hasRate ? th('rate', 'Response rate', 1) : '') +
      RATINGS.map(function (q, i) { return th('avg' + i, esc(col(q).replace(' (1-5)', '')), 1); }).join('') +
      (PRACTICE ? th('practice', PRACTICE_SHORT, 1) : '') + (L_OVERALL ? th('leader', 'Session Leader scores', 1) : '') + '</tr></thead><tbody>';
    html += shown.map(function (d) {
      return '<tr><td class="num rank">' + (d.rank == null ? '–' : ordinal(d.rank) + (d.tied ? '<div class="t-sub">tied</div>' : '')) + '</td><td><button type="button" class="linkish" data-card="' + esc(d.s.id) + '">' + esc(d.s.title) + '</button>' +
        (d.s.speakers ? '<div class="t-sub">' + esc(d.s.speakers) + '</div>' : '') + '</td>' +
        '<td>' + esc(dayLabel(d.s.date)) + ', ' + esc(d.s.start) + '<div class="t-sub">' + esc(d.s.room) + '</div></td>' +
        '<td class="num">' + d.st.n + '</td>' +
        (hasRate ? '<td class="num">' + (d.rate == null ? '–' : Math.round(d.rate * 100) + '%') + '</td>' : '') +
        d.st.avgs.map(function (a, i) {
          return '<td class="num">' + fmt1(a) + (i === 0 && a != null ? '<span class="scorebar" aria-hidden="true"><i style="width:' + (a / 5 * 100) + '%"></i></span>' : '') + '</td>';
        }).join('') +
        (PRACTICE ? '<td class="num">' + pct(d.st.practiceYes, d.st.practiceN) + '</td>' : '') +
        (L_OVERALL ? '<td class="num">' + (d.leaderAll.length ? d.leaderAll.join(' · ') : '–') + '</td>' : '') + '</tr>';
    }).join('') + '</tbody></table></div>';
    if (!shown.length) html += '<p class="empty">No sessions have that many responses yet. Lower the minimum above.</p>';
    $('tab-rankings').innerHTML = html;
  }

  // A scorecard (one session, or a workshop with all its runs) in the shape the copy/Excel code uses
  function cardItem(i) {
    var w = (state.cardShown || [])[+i]; if (!w) return null;
    return { s: { title: w.title, speakers: w.speakers, track: w.runs[0].track }, runs: w.runs };
  }
  // One scorecard's responses and reports (all runs of a workshop)
  function rankRowData(d) {
    var ids = d.runs.map(function (s) { return s.id; });
    var inRuns = function (x) { return d.runs.some(function (s) { return sameSession(x, s); }); };
    return {
      responses: fRows().filter(function (r) { return !r.typed && ids.indexOf(r.id) > -1; }),
      leaders: leaders.filter(inRuns), panel: panel.filter(inRuns)
    };
  }

  // Plain text for pasting into an AI tool: the session, its numbers, every answer, and the internal reports.
  // No attendee names or emails.
  function sessionDigest(d) {
    var x = rankRowData(d), st = statsFor(x.responses), L = [];
    var line = function (t) { L.push(t); };
    var f1 = function (v) { return v == null ? 'n/a' : (Math.round(v * 10) / 10).toFixed(1); };
    line('IFC 2026 session feedback (International Fundraising Congress, Netherlands, 20-23 Oct 2026)');
    line('');
    line('Session: ' + d.s.title);
    if (d.s.speakers) line('Speakers: ' + d.s.speakers);
    line((d.runs.length > 1 ? 'Runs: ' : 'When and where: ') + d.runs.map(runLabel).join('; '));
    if (d.s.track) line('Track: ' + d.s.track);
    var nOnline = x.responses.filter(function (r) { return r.online; }).length;
    line('Responses: ' + st.n + (nOnline ? ' (' + nOnline + ' from IFC Online viewers)' : ''));
    line('');
    line('AVERAGE SCORES (1 = poor, 5 = excellent)');
    RATINGS.forEach(function (q, i) { line('- ' + col(q).replace(' (1-5)', '') + ': ' + f1(st.avgs[i])); });
    speakerScores(x.responses).forEach(function (sp) { line('- Speaker ' + sp.name + ': ' + f1(sp.avg) + ' (' + sp.n + ' ratings)'); });
    CHOICES.forEach(function (q) {
      var vals = x.responses.map(function (r) { return r.raw[col(q)]; }).filter(Boolean);
      if (vals.length) line('- ' + col(q) + ': ' + (q.options || []).map(function (o) {
        return o + ' ' + Math.round(100 * vals.filter(function (v) { return v === o; }).length / vals.length) + '%';
      }).join(', ') + ' (' + vals.length + ' answers)');
    });
    line('');
    line('INDIVIDUAL RESPONSES');
    if (!x.responses.length) line('None yet.');
    x.responses.slice().sort(function (a, b) { return String(a.when).localeCompare(String(b.when)); }).forEach(function (r, i) {
      var parts = RATINGS.map(function (q) {
        var v = num(r.raw[col(q)]); if (v == null) return '';
        var det = q === SPEAKERQ && q.detailColumn && r.raw[q.detailColumn] ? ' (' + String(r.raw[q.detailColumn]).replace(/;\s*/g, ', ') + ')' : '';
        return col(q).replace(' (1-5)', '') + ' ' + v + det;
      }).concat(CHOICES.map(function (q) { return r.raw[col(q)] ? col(q) + ': ' + r.raw[col(q)] : ''; })).filter(Boolean);
      line((i + 1) + '. ' + parts.join('; ') + (r.online ? ' [online viewer]' : '') + (d.runs.length > 1 ? ' [' + runLabel(byId[r.id] || d.s) + ']' : ''));
      TEXTS.forEach(function (q) {
        var t = String(r.raw[col(q)] || '').trim(), en = String(r.raw[col(q) + ' (English)'] || '').trim();
        if (t) line('   ' + col(q) + ': "' + t.replace(/^'/, '') + '"' + (en ? ' (English: "' + en.replace(/^'/, '') + '")' : ''));
      });
    });
    [[LG, x.leaders, 'SESSION LEADER REPORTS (internal: from the Session Leader who hosted the session)'],
     [PG, x.panel, 'ADVISORY PANEL REPORTS (internal)']].forEach(function (g) {
      if (!g[1].length) return;
      line(''); line(g[2]);
      g[1].forEach(function (l) {
        line('- ' + (l.name || g[0].who) + (/-P1$/.test(l.id) ? ' (part 1)' : '') + ': ' +
          g[0].ratings.map(function (q) { return q.label + ' ' + (num(l.raw[col(q)]) || 'n/a') + '/5'; }).join('; '));
        g[0].texts.forEach(function (q) {
          var t = String(l.raw[col(q)] || '').trim(), en = String(l.raw[col(q) + ' (English)'] || '').trim();
          if (t) line('   ' + q.label + ': "' + t.replace(/^'/, '') + '"' + (en ? ' (English: "' + en.replace(/^'/, '') + '")' : ''));
        });
      });
    });
    return L.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, bad) {                  // older browsers
      var t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy') ? ok() : bad(); } catch (e) { bad(e); } finally { t.remove(); }
    });
  }
  function copyForAI(btn) {
    var d = cardItem(btn.dataset.copyai); if (!d) return;
    copyText(sessionDigest(d)).then(function () {
      btn.textContent = 'Copied!'; btn.classList.add('done');
      setTimeout(function () { btn.textContent = 'Copy for AI'; btn.classList.remove('done'); }, 2000);
    }, function () { alert(coded('Could not copy. Your browser blocked it: try again, or use Excel instead.', 'D205')); });
  }
  function sessionExcel(btn) {
    var d = cardItem(btn.dataset.xlsx); if (!d) return;
    var x = rankRowData(d);
    xlsxDownload(btn, [
      { name: 'Responses', rows: rawSheet(x.responses) },
      { name: 'Session Leader reports', rows: rawSheet(x.leaders) },
      { name: 'Advisory Panel reports', rows: rawSheet(x.panel) }
    ], 'IFC2026 - ' + d.s.title.replace(/[\\/:*?"<>|\[\]]+/g, '').slice(0, 70));
  }

  // The ranking as rows for a spreadsheet: best to worst by overall score, sessions with no responses last
  function rankingSheet() {
    var data = rankingData();
    var ok = rankAll(data);
    var rest = data.filter(function (d) { return ok.indexOf(d) === -1; }).sort(function (a, b) { return b.st.n - a.st.n; });
    ok.forEach(function (d) { d.rankLabel = d.rank + (d.tied ? ' (tied)' : ''); });
    rest.forEach(function (d) { d.rankLabel = 'no responses'; });
    data = ok.concat(rest);
    var head = ['Rank', 'Session ID', 'Session', 'Speakers', state.combine ? 'Room / runs' : 'Room', 'Day', 'Start', 'Track', 'Responses']
      .concat(RATINGS.map(function (q) { return 'Average ' + col(q); }))
      .concat(PRACTICE ? ['% ' + PRACTICE.options[0]] : []).concat(L_OVERALL ? ['Session Leader scores'] : []);
    return [head].concat(data.map(function (d) {
      return [d.rankLabel, d.s.id, d.s.title, d.s.speakers, d.s.room, d.s.date, d.s.start, d.s.track, d.st.n]
        .concat(d.st.avgs.map(function (a) { return a == null ? '' : Math.round(a * 100) / 100; }))
        .concat(PRACTICE ? [d.st.practiceN ? Math.round(100 * d.st.practiceYes / d.st.practiceN) : ''] : [])
        .concat(L_OVERALL ? [d.leaderAll.join(' / ')] : []);
    }));
  }

  // Ranking tab button: the ranking as shown (follows the filters)
  function exportRanking(btn) {
    var aoa = rankingSheet();
    xlsxDownload(btn, [{ name: 'Session ranking', rows: aoa }], 'IFC2026 session ranking' + (state.combine ? ' (workshops combined)' : ''));
  }

  // Build and download an Excel file: sheets = [{ name, rows: [[header...], [values...]] }]
  function xlsxDownload(btn, sheets, fileName) {
    var label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing\u2026'; }
    return loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js').then(function () {
      var X = window.XLSX, wb = X.utils.book_new();
      sheets.forEach(function (sh) {
        var rowsX = sh.rows.map(function (r) {
          return r.map(function (v) { return typeof v === 'string' ? v.replace(/^'(?=[=+\-@])/, '') : v; });
        });
        var w = X.utils.aoa_to_sheet(rowsX);
        w['!cols'] = (rowsX[0] || []).map(function (h, c) {
          var len = rowsX.slice(0, 200).reduce(function (m, r) { return Math.max(m, String(r[c] == null ? '' : r[c]).length); }, String(h).length);
          return { wch: Math.min(60, Math.max(8, len + 2)) };
        });
        if (rowsX[0] && rowsX[0].length) w['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: rowsX[0].length - 1 } }) };
        X.utils.book_append_sheet(wb, w, sh.name.slice(0, 31));
      });
      X.writeFile(wb, fileName + ($('showTest').checked ? ' (TEST)' : '') + '.xlsx');
      return true;
    }).catch(function () {
      alert(coded('Could not create the Excel file (no connection to the export library). Try again.', 'D204'));
      return false;
    }).then(function (ok) { if (btn) { btn.disabled = false; btn.innerHTML = label; } return ok; });
  }

  // The full export ignores the filters: clear them for a moment, run, put them back
  function unfiltered(withOnline, fn) {
    var ids = ['fDay', 'fType', 'fTrack', 'fRoom', 'fText'], keep = ids.map(function (id) { return $(id).value; }), on = state.withOnline;
    ids.forEach(function (id) { $(id).value = ''; }); state.withOnline = withOnline;
    try { return fn(); } finally { ids.forEach(function (id, i) { $(id).value = keep[i]; }); state.withOnline = on; }
  }

  // Every answer, one row each, all the columns from the Sheet (including names and emails of people open to contact)
  var NOT_EXPORTED = ['_row'];
  function rawSheet(list) {
    var cols = [];
    list.forEach(function (x) { Object.keys(x.raw).forEach(function (k) { if (cols.indexOf(k) === -1 && NOT_EXPORTED.indexOf(k) === -1) cols.push(k); }); });
    return [cols].concat(list.map(function (x) {
      return cols.map(function (k) {
        var v = x.raw[k];
        if (k === 'Timestamp' && v) { var d = new Date(v); if (!isNaN(d)) return d.toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 16); }
        return v == null ? '' : v;
      });
    }));
  }
  function fullExport(btn, kind) {
    var withOnline = $('exOnline').checked, tag = withOnline ? '' : ' (in person only)';
    var done = kind === 'summary'
      ? xlsxDownload(btn, [{ name: 'Session ranking', rows: unfiltered(withOnline, rankingSheet) }], 'IFC2026 summary - session ranking' + tag)
      : xlsxDownload(btn, [
          { name: 'Responses', rows: rawSheet(rows.filter(function (r) { return withOnline || !r.online; })) },
          { name: 'Session Leader reports', rows: rawSheet(leaders) },
          { name: 'Advisory Panel reports', rows: rawSheet(panel) }
        ], 'IFC2026 all responses' + tag);
    done.then(function (ok) { if (ok) closeExport(); });
  }

  /* ---------- outstanding Session Leader reports ---------- */

  // Now in conference time, in minutes (?now=2026-10-21T16:00 in the address to test)
  function nowMin() {
    var o = (location.search.match(/[?&]now=([^&]+)/) || [])[1];
    var parts = {};
    if (o) { o = decodeURIComponent(o).split('T'); var d = o[0].split('-'), t = (o[1] || '12:00').split(':'); return Date.UTC(+d[0], +d[1] - 1, +d[2], +t[0], +t[1]) / 60000; }
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).forEach(function (x) { parts[x.type] = x.value; });
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) / 60000;
  }
  function slotMin(date, start) { var d = date.split('-'), t = start.split(':'); return Date.UTC(+d[0], +d[1] - 1, +d[2], +t[0], +t[1]) / 60000; }
  function plainName(n) { return String(n).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); }

  // From the "Session Leader allocations" tab: for each time slot that has started, who still owes a report.
  // Follows the Session Leader dropdown (one person) but not the other filters.
  function outstanding() {
    var have = {}, now = nowMin(), slots = {}, p1 = CFG.masterclassPart1 || {};
    leaders.forEach(function (l) { have[plainName(l.name) + '|' + l.id] = 1; });
    // reports each person sent per time slot, to spot "sent one for a different session in this slot"
    var inSlot = {};
    leaders.forEach(function (l) {
      if (!l.date || !l.start) return;
      var k = plainName(l.name) + '|' + l.date + ' ' + l.start;
      (inSlot[k] = inSlot[k] || []).push(l);
    });
    (state.data.cleared || []).forEach(function (c) { have[plainName(c.name) + '|' + c.id] = 1; });   // cleared by the team
    (state.data.allocations || []).forEach(function (a) {
      var s = byId[a.id], part1 = /-P1$/.test(a.id);
      if (part1 && byId[baseId(a.id)]) s = { title: byId[baseId(a.id)].title + ' (Part 1)', room: byId[baseId(a.id)].room, date: p1.date, start: p1.start };
      if (!s || !s.date || !s.start || slotMin(s.date, s.start) > now) return;       // cancelled, or not started yet
      var missing = a.leaders.split(/\s*\/\s*/).filter(function (n) {
        return n && !have[plainName(n) + '|' + a.id] && (!LG.filterVal || plainName(n) === plainName(LG.filterVal));
      });
      if (!missing.length) return;
      var k = s.date + ' ' + s.start, other = {};
      missing.forEach(function (n) {
        var o = (inSlot[plainName(n) + '|' + k] || []).filter(function (l) { return l.id !== a.id; });
        if (o.length) other[n] = o;
      });
      (slots[k] = slots[k] || { date: s.date, start: s.start, items: [] }).items.push({ s: s, id: a.id, names: missing, other: other });
    });
    return Object.keys(slots).sort().reverse().map(function (k) { return slots[k]; });   // latest slot first
  }

  // A session as the pop-up shows it (part 1 masterclasses aren't in the session list)
  function allocSession(id) {
    var p1 = CFG.masterclassPart1 || {}, b = byId[baseId(id)];
    if (/-P1$/.test(id)) return b ? { title: b.title + ' (Part 1)', room: b.room, date: p1.date, start: p1.start } : null;
    return byId[id] || null;
  }

  function showOutstanding() {
    var list = outstanding();
    var clr = function (id, name, undo) {
      return '<button type="button" class="link os-clear" data-clearid="' + esc(id) + '" data-clearname="' + esc(name) + '"' + (undo ? ' data-undo="1"' : '') + '>' +
        (undo ? 'Undo' : 'Clear') + '</button>';
    };
    var people = [];
    list.forEach(function (sl) { sl.items.forEach(function (it) { it.names.forEach(function (n) { if (people.indexOf(n) === -1) people.push(n); }); }); });
    people.sort(function (a, b) { return a.localeCompare(b); });
    var html = list.length ? list.map(function (sl) {
      var n = sl.items.reduce(function (t, it) { return t + it.names.length; }, 0);
      return '<div class="os-slot"><h3>' + esc(dayLabel(sl.date) + ', ' + sl.start) + ' <span class="count warn">' + n + '</span></h3><ul>' +
        sl.items.sort(function (a, b) { return a.s.room.localeCompare(b.s.room); }).map(function (it) {
          return '<li>' + it.names.map(function (nm) { return '<span class="os-name"><strong>' + esc(nm) + '</strong> ' + clr(it.id, nm) + '</span>'; }).join('') +
            '<span>' + esc(it.s.title) + ' \u00b7 ' + esc(it.s.room) + '</span>' +
            it.names.filter(function (nm) { return it.other[nm]; }).map(function (nm) {
              return '<span class="os-other">' + esc(nm) + ' sent a report for ' + it.other[nm].map(function (l) {
                return '\u201c' + esc(l.title) + '\u201d' + (l.room ? ' (' + esc(l.room) + ')' : '');
              }).join(', ') + ' in this time slot instead. Wrong session picked?</span>';
            }).join('') + '</li>';
        }).join('') + '</ul></div>';
    }).join('') : '<p class="ex-note" style="font-size:15px;color:var(--ink)">Nothing outstanding' + (LG.filterVal ? ' for ' + esc(LG.filterVal) : '') + '. Every Session Leader has sent a report for every session that has started.</p>';
    // Clear everything for one person (e.g. they had to leave)
    if (people.length) html = '<div class="os-all"><label>Clear all for <select id="clearWho"><option value="">Choose a Session Leader\u2026</option>' +
      people.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('') + '</select></label>' +
      '<button type="button" class="secondary small" id="clearAllBtn">Clear all</button></div>' + html;
    var cl = (state.data.cleared || []).filter(function (c) { return !LG.filterVal || plainName(c.name) === plainName(LG.filterVal); });
    if (cl.length) html += '<details class="os-cleared"><summary>Cleared by the team (' + cl.length + ')</summary><ul>' + cl.map(function (c) {
      var s = allocSession(c.id);
      return '<li><span class="os-name"><strong>' + esc(c.name) + '</strong> ' + clr(c.id, c.name, true) + '</span><span>' +
        esc(s ? s.title + ' \u00b7 ' + dayLabel(s.date) + ', ' + s.start : c.id) + '</span></li>';
    }).join('') + '</ul></details>';
    html += '<p class="ex-note">Time slots appear once they start. Session Leaders come from the "Session Leader allocations" tab in the Sheet' +
      (LG.filterVal ? '. Showing ' + esc(LG.filterVal) + ' only (Session Leader dropdown).' : '.') +
      ' Clear removes a report from this list for everyone (for example, if they reported in person); Undo brings it back.</p>';
    $('exportTitle').textContent = 'Outstanding reports';
    $('exportBody').innerHTML = html;
    var dlg = $('exportDlg');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }

  // Clear (or undo) outstanding reports: items = [{ id, name }]
  function clearOutstanding(items, undo, btn) {
    if (!items.length) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }
    fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'clearOutstanding', key: state.key, items: items, undo: !!undo })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { var err = new Error(j.error || 'not saved'); err.code = j.code; err.answered = true; throw err; }
      var k = function (c) { return c.id + '|' + plainName(c.name); }, keys = items.map(k);
      var cur = (state.data.cleared || []).filter(function (c) { return keys.indexOf(k(c)) === -1; });
      state.data.cleared = undo ? cur : cur.concat(items);                    // show it now; the next refresh confirms it
      renderLeaders(); showOutstanding();
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = undo ? 'Undo' : 'Clear'; }
      alert(e.answered ? coded('Not saved: ' + e.message + '. Please try again.', 'D201', e.code)
                       : coded('Could not reach the database. Please try again.', 'D202'));
    });
  }

  /* ---------- assign a key issue ---------- */

  var assigning = null;          // the "Assign" button that opened the pop-up
  function showAssign(btn) {
    assigning = btn;
    var cur = btn.dataset.owner || '';
    $('exportTitle').textContent = 'Assign this key issue';
    $('exportBody').innerHTML = OWNERS.map(function (o) {
      return '<button type="button" class="ex-opt' + (o === cur ? ' current' : '') + '" data-setowner="' + esc(o) + '"><strong>' + esc(o) + (o === cur ? ' (now)' : '') + '</strong></button>';
    }).join('') + (cur ? '<button type="button" class="link" data-setowner="">Remove assignment</button>' : '');
    var dlg = $('exportDlg');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function saveOwner(owner, choice) {
    var btn = assigning; if (!btn) return;
    choice.disabled = true; choice.textContent = 'Saving\u2026';
    fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'resolve', kind: btn.dataset.kind === 'panel' ? 'panel' : 'leader', key: state.key, test: $('showTest').checked,
        row: +btn.dataset.assignissue, timestamp: btn.dataset.ts, owner: owner })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { var err = new Error(j.error || 'not saved'); err.code = j.code; err.answered = true; throw err; }
      // show it straight away; the next refresh confirms it from the Sheet
      var list = btn.dataset.kind === 'panel' ? panel : leaders;
      list.forEach(function (l) { if (String(l.row) === btn.dataset.assignissue && String(l.when) === btn.dataset.ts) l.owner = owner; });
      closeExport();
      if (btn.dataset.kind === 'panel') renderPanel(); else renderLeaders();
      load();
    }).catch(function (e) {
      closeExport();
      alert(e.answered ? coded('Not saved: ' + e.message + '. Please try again.', 'D201', e.code)
                       : coded('Could not reach the database. Please try again.', 'D202'));
    });
  }

  // The pop-up: what = 'full' (top of the page) or 'scorecards'
  function openExport(what) {
    var opt = function (id, title, sub) { return '<button type="button" class="ex-opt" id="' + id + '"><strong>' + title + '</strong><span>' + sub + '</span></button>'; };
    var html;
    if (what === 'full') {
      html = '<label class="toggle"><input type="checkbox" id="exOnline" checked> Include IFC Online responses</label>' +
        opt('exSummary', 'Summary (Excel)', 'The session ranking: one row per session, best to worst, with average scores.') +
        opt('exFull', 'Every response (Excel)', 'All answers, one row each (with contact details), plus Session Leader and Advisory Panel reports on their own sheets.') +
        '<p class="ex-note">Exports everything, whatever filters are set above. Includes names and emails of people open to being contacted.</p>';
    } else {
      html = opt('wordBtn', 'Word (for editing)', 'The scorecards shown, ready to edit before sending to speakers.') +
        (L_TAKEAWAY ? opt('takeawaysBtn', 'Key takeaways (Excel)', 'Every Session Leader\'s key takeaway, by day and time.') : '') +
        opt('printBtn', 'Print or save as PDF', 'Opens your browser\'s print window.') +
        '<p class="ex-note">Follows the filters and the settings on the Scorecards tab.</p>';
    }
    $('exportTitle').textContent = what === 'full' ? 'Export results' : 'Export scorecards';
    $('exportBody').innerHTML = html;
    var dlg = $('exportDlg');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  // Word: before downloading, confirm which internal reports go in (and one file or a zip)
  function wordConfirm() {
    var sd = scorecardData(), picked = state.picked || [];
    var n = picked.length ? sd.ws.filter(function (w) { return picked.indexOf(w.key) > -1; }).length : sd.ws.length;
    if (!n) { alert('Nothing to export with these filters.'); return; }
    $('exportTitle').textContent = 'Word (for editing)';
    $('exportBody').innerHTML =
      '<p class="ex-note" style="font-size:15px;color:var(--ink)"><strong>' + n + '</strong> ' + (n === 1 ? 'session' : 'sessions') + '. Include these internal reports?</p>' +
      '<label class="toggle"><input type="checkbox" id="wLeaders"' + (state.withLeaders ? ' checked' : '') + '> Include Session Leader reports</label>' +
      '<label class="toggle"><input type="checkbox" id="wPanel"' + (state.withPanel ? ' checked' : '') + '> Include Advisory Panel reports</label>' +
      (n > 1 ? '<label class="toggle"><input type="radio" name="wFiles" id="wOne" checked> One Word document, each session on its own page</label>' +
               '<label class="toggle"><input type="radio" name="wFiles" id="wZip"> A separate Word file for each (in a zip)</label>' : '<input type="checkbox" id="wZip" hidden>') +
      '<button type="button" class="ex-opt" id="wordGo"><strong>Download Word</strong><span>Remember to remove internal reports before sending to speakers.</span></button>' +
      '<button type="button" class="link" id="wordBack">Back</button>';
  }
  function closeExport() { var dlg = $('exportDlg'); if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); }


  /* ---------- comments ---------- */

  // One response's other answers in a line: "Overall 4 · Speakers 4.5 (Jane Doe 4, John Roe 5) · Relevance 3 · Learned something new: Yes"
  function answersLine(r) {
    var parts = RATINGS.slice(1).map(function (q) {
      var v = num(r.raw[col(q)]);
      if (v == null) return '';
      var detail = q === SPEAKERQ && q.detailColumn && r.raw[q.detailColumn] ? ' (' + String(r.raw[q.detailColumn]).replace(/:\s*/g, ' ').replace(/;\s*/g, ', ') + ')' : '';
      return esc(col(q).replace(' (1-5)', '')) + ' <strong>' + v + '</strong>' + esc(detail);
    }).concat(CHOICES.map(function (q) {
      var v = r.raw[col(q)];
      return v ? esc(col(q)) + ': <strong>' + esc(v) + '</strong>' : '';
    })).filter(Boolean);
    return parts.length ? '<p class="answers">' + parts.join(' · ') + '</p>' : '';
  }

  function renderComments() {
    // Names and emails show only here (people who ticked "open to being contacted"), never on scorecards (the full Excel export includes them)
    // Responses tab: every response, written comment or not (21 Oct), newest first
    var all = rows.filter(function (r) {
      return (state.withOnline || !r.online) && matches(r, commentText(r) + ' ' + r.contactName + ' ' + r.contactEmail);
    }).sort(function (a, b) { return String(b.when).localeCompare(String(a.when)); });
    var nContact = all.filter(function (r) { return r.contact; }).length;
    var nWritten = all.filter(function (r) { return commentText(r).trim(); }).length;
    var list = all.filter(function (r) { return (!state.onlyContact || r.contact) && (!state.onlyWritten || commentText(r).trim()); });
    // New responses don't appear by themselves while someone is reading this tab: they wait behind
    // a "Show N new responses" button. When the tab isn't open, it just keeps up to date.
    var newest = rows.reduce(function (m, r) { return String(r.when) > m ? String(r.when) : m; }, '');
    if (state.respPinned == null || state.tab !== 'comments') state.respPinned = newest;
    var waitingNew = list.filter(function (r) { return String(r.when) > state.respPinned; });
    list = list.filter(function (r) { return String(r.when) <= state.respPinned; });
    var shown = list.slice(0, state.commentsShown);
    var html = (waitingNew.length ? '<button type="button" class="new-resp" id="showNewResp">Show ' + waitingNew.length + ' new response' +
        (waitingNew.length === 1 ? '' : 's') + '</button>' : '') +
      '<div class="controls"><span>' + all.length + ' responses, newest first.</span>' +
      '<label class="toggle"><input type="checkbox" id="onlyWritten"' + (state.onlyWritten ? ' checked' : '') + '> Only with a written comment (' + nWritten + ')</label>' +
      '<label class="toggle"><input type="checkbox" id="onlyContact"' + (state.onlyContact ? ' checked' : '') + '> Only people open to being contacted (' + nContact + ')</label></div>' +
      '<div class="comments">' +
      shown.map(commentCard).join('') + '</div>';
    if (list.length > shown.length) html += '<p><button type="button" class="secondary small" id="moreComments">Show more</button></p>';
    if (!list.length) html = '<p class="empty">No responses match these filters yet.</p>';
    $('tab-comments').innerHTML = html;
  }

  /* ---------- English translations of written answers ---------- */

  // The Sheet adds "<column> (English)" for answers written in another language (done automatically by the script)
  function trLine(x, column) {
    var en = x.raw[column + ' (English)'];
    return en ? '<p class="tr-en"><span class="k">English:</span> ' + esc(String(en).replace(/^'/, '')) + '</p>' : '';
  }

  function commentCard(r) {
        return '<article class="comment"><div class="meta"><button type="button" class="linkish who" data-card="' + esc(r.id) + '">' + esc(r.title) + '</button> · ' +
          (r.online ? '<strong>Online</strong>' : esc(r.room)) + ' · ' + esc(dayLabel(r.date)) + ' ' + esc(r.start) +
          (num(r.raw[OVERALL]) ? ' · <span class="stars-txt" aria-label="' + num(r.raw[OVERALL]) + ' out of 5">' + starsText(num(r.raw[OVERALL])) + '</span>' : '') +
          ' · ' + esc(localTime(r.when)) + '</div>' +
          answersLine(r) +
          TEXTS.map(function (q) {
            var v = r.raw[col(q)];
            return v ? '<p><span class="k">' + esc(col(q)) + ':</span> ' + esc(v) + '</p>' + trLine(r, col(q)) : '';
          }).join('') +
          (r.contact ? '<p class="contact-line"><span class="k">Open to being contacted:</span> ' + esc(r.contactName) + ' · <a href="mailto:' +
            encodeURIComponent(r.contactEmail).replace(/%40/g, '@') + '?subject=' + encodeURIComponent('Your feedback on "' + r.title + '" at IFC 2026') + '">' +
            esc(r.contactEmail) + '</a></p>' : '') + '</article>';
  }

  /* ---------- IFC Online: feedback from the /online form, kept apart from in-person ---------- */

  function renderOnline() {
    var ids = (CFG.online && CFG.online.sessions || []).map(String);
    var on = rows.filter(function (r) { return r.online && matches(r, commentText(r) + ' ' + r.contactName + ' ' + r.contactEmail); });
    var list = ids.map(function (id) { return byId[id]; }).filter(Boolean).filter(function (s) { return matches(s, false); });
    var st = statsFor(on), rated = {}; on.forEach(function (r) { rated[r.id] = 1; });
    var html = '<p class="sub">Feedback from the IFC Online form (ifc2026survey.com/online), kept separate from in-person feedback. ' +
      'To add it to Session rankings or Scorecards, tick "Include online reviews" there.</p><div class="tiles">' +
      tile('Online responses', String(on.length), on.length ? '' : 'None yet') +
      tile('Sessions with feedback', String(list.filter(function (s) { return rated[s.id]; }).length) + ' <small>of ' + list.length + '</small>', 'Online sessions') +
      tile('Average overall', st.avgs[0] != null ? fmt1(st.avgs[0]) + ' <small>/ 5</small>' : '–', 'From ' + on.filter(function (r) { return num(r.raw[OVERALL]) != null; }).length + ' ratings') +
      (PRACTICE ? tile(PRACTICE_SHORT, pct(st.practiceYes, st.practiceN), 'said "' + esc(PRACTICE.options[0]) + '"') : '') + '</div>';
    html += '<h2 class="section">Online sessions</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Session</th><th>When</th>' +
      '<th class="num">Online responses</th>' + RATINGS.map(function (q) { return '<th class="num">' + esc(col(q).replace(' (1-5)', '')) + '</th>'; }).join('') +
      (PRACTICE ? '<th class="num">' + esc(PRACTICE_SHORT) + '</th>' : '') + '<th class="num">In-person overall</th></tr></thead><tbody>' +
      list.map(function (s) {
        var g = on.filter(function (r) { return r.id === s.id; }), sst = statsFor(g);
        var live = statsFor(rows.filter(function (r) { return !r.online && r.id === s.id; }));
        return '<tr><td><button type="button" class="linkish" data-card="' + esc(s.id) + '">' + esc(s.title) + '</button>' +
          (s.speakers ? '<div class="t-sub">' + esc(s.speakers) + '</div>' : '') + '</td>' +
          '<td>' + esc(dayLabel(s.date) + ', ' + s.start) + '</td><td class="num">' + g.length + '</td>' +
          sst.avgs.map(function (v) { return '<td class="num">' + fmt1(v) + '</td>'; }).join('') +
          (PRACTICE ? '<td class="num">' + pct(sst.practiceYes, sst.practiceN) + '</td>' : '') +
          '<td class="num">' + (live.n ? fmt1(live.avgs[0]) + ' <span class="t-sub">(' + live.n + ')</span>' : '–') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    var withText = on.filter(function (r) { return commentText(r).trim() || r.contact; })
      .sort(function (a, b) { return String(b.when).localeCompare(String(a.when)); });
    html += '<h2 class="section">Online comments</h2>' + (withText.length
      ? '<div class="comments">' + withText.map(commentCard).join('') + '</div>'
      : '<p class="empty">No online comments yet.</p>');
    $('tab-online').innerHTML = html;
  }


  /* ---------- scorecards ---------- */

  // Session Leader and Advisory Panel reports on a scorecard (internal: never sent to speakers as is)
  // inc = { leaders: true/false, panel: true/false } (the two tickboxes on the Scorecards tab)
  function leaderBlock(s, prefix, inc) {
    return (inc.leaders ? reportBlock(LG, leaders, s, 'Session Leader report', prefix) : '') +
           (inc.panel ? reportBlock(PG, panel, s, 'Advisory Panel report', prefix) : '');
  }
  function included() { return { leaders: state.withLeaders, panel: state.withPanel }; }
  function reportBlock(G, all, s, heading, prefix) {
    var ls = all.filter(function (l) { return sameSession(l, s); });
    if (!ls.length) return '';
    return '<div class="leader-box"><div class="qname">' + (prefix || '') + heading + (ls.length > 1 ? 's (' + ls.length + ')' : '') + '</div>' +
      ls.map(function (l) {
        var part = /-P1$/.test(l.id) ? ' (part 1)' : (s.track === 'Masterclasses' ? ' (part 2)' : '');
        return '<div class="leader-one"><strong>' + esc(l.name || G.who) + '</strong>' + part + ' · ' +
          G.ratings.map(function (q) { return esc(q.label) + ' <strong>' + (num(l.raw[col(q)]) || '–') + '</strong>/5'; }).join(' · ') +
          G.texts.map(function (q) {
            var v = l.raw[col(q)];
            return v ? '<p class="' + (col(q) === G.issues ? 'issue' : '') + '"><span class="k">' + esc(q.label) + ':</span> ' + esc(v) + '</p>' + trLine(l, col(q)) : '';
          }).join('') + '</div>';
      }).join('') + '</div>';
  }

  // Session Leaders and Advisory Panel tabs: every report, key issues first
  function renderLeaders() { renderReports(LG, leaders); }
  function renderPanel() { renderReports(PG, panel); }
  function renderReports(G, all) {
    var list = all.filter(function (l) {
      return (!G.filterVal || l.name === G.filterVal) && matches(l, l.name + ' ' + G.texts.map(function (q) { return l.raw[col(q)] || ''; }).join(' '));
    }).sort(function (a, b) { return (a.date + a.start + a.room).localeCompare(b.date + b.start + b.room); });
    var leaderNames = all.map(function (l) { return l.name; }).filter(function (n, i, a) { return n && a.indexOf(n) === i; }).sort(function (a, b) { return a.localeCompare(b); });
    var hasIssue = function (l) { return G.issues && String(l.raw[G.issues] || '').trim(); };
    var issues = list.filter(function (l) { return hasIssue(l) && !l.handled; });
    var handledN = list.filter(function (l) { return hasIssue(l) && l.handled; }).length;
    $(G.count).textContent = all.filter(function (l) { return hasIssue(l) && !l.handled; }).length || '';
    var covered = {}; list.forEach(function (l) { covered[baseId(l.id)] = 1; });
    // sort by the chosen column (click a heading); ties keep day/time order
    var lval = function (l) {
      var k = G.sortBy;
      if (k === 'when') return l.date + l.start + l.room;
      if (k === 'sent') return String(l.when);                            // when the report came in
      if (k === 'title') return l.title.toLowerCase();
      if (k === 'name') return String(l.name).toLowerCase();
      if (k === 'issue') return G.issues && String(l.raw[G.issues] || '').trim() ? 1 : 0;
      var v = num(l.raw[k]); return v == null ? -1 : v;
    };
    var lsort = function (a, b) { var x = lval(a), y = lval(b); return (x > y ? 1 : x < y ? -1 : 0) * G.sortDir || (a.date + a.start).localeCompare(b.date + b.start); };
    list.sort(lsort); issues.sort(lsort);
    var html = '<div class="controls"><label>' + G.who + ' <select id="' + G.filter + '"><option value="">' + G.all + '</option>' +
      leaderNames.map(function (n) { return '<option' + (n === G.filterVal ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') +
      '</select></label>' +
      (G === LG && (state.data.allocations || []).length ? (function () {
        var n = outstanding().reduce(function (t, sl) { return t + sl.items.reduce(function (u, it) { return u + it.names.length; }, 0); }, 0);   // one per missing report
        return '<button type="button" class="secondary small" id="outstandingBtn">Outstanding reports' + (n ? ' <span class="count warn">' + n + '</span>' : '') + '</button>';
      })() : '') +
      // On/off filter: show only the key issues already marked as handled
      '<button type="button" class="secondary small solved-btn" data-solved="' + G.kind + '" aria-pressed="' + !!G.solvedOnly + '">' +
        (G.solvedOnly ? 'Showing solved issues \u00d7' : 'Solved issues' + (handledN ? ' <span class="count">' + handledN + '</span>' : '')) + '</button>' +
      '</div>' +
      '<div class="tiles">' +
      tile(G.reports, String(list.length), Object.keys(covered).length + ' of ' + fSessions().length + ' sessions covered') +
      G.ratings.map(function (q) {
        var vals = list.map(function (l) { return num(l.raw[col(q)]); }).filter(function (v) { return v != null; });
        return tile('Average ' + q.label.toLowerCase(), vals.length ? fmt1(mean(vals)) + ' <small>/ 5</small>' : '–', vals.length + ' ratings');
      }).join('') +
      tile('Open key issues', String(issues.length), (issues.length ? 'Listed first below' : 'Nothing waiting') + (handledN ? ' · ' + handledN + ' handled' : '')) + '</div>';
    var row = function (l) {
      return '<tr' + (issues.indexOf(l) > -1 ? ' class="has-issue"' : '') + '><td><button type="button" class="linkish" data-card="' + esc(l.id) + '">' + esc(l.title) + '</button></td>' +
        '<td>' + esc(dayLabel(l.date) + ', ' + l.start) + '<div class="t-sub">' + esc(l.room) + '</div></td>' +
        '<td>' + esc(l.name) + (l.versions > 1 ? '<div class="t-sub">Updated report</div>' : '') + '</td>' +
        '<td>' + esc(localTime(l.when)) + '</td>' +
        G.ratings.map(function (q) { return '<td class="num">' + (num(l.raw[col(q)]) || '–') + '</td>'; }).join('') +
        '<td>' + G.texts.map(function (q) {
          var v = l.raw[col(q)];
          var cls = col(q) === G.issues ? (l.handled ? 'issue handled' : 'issue') : '';
          return v ? '<p class="' + cls + '"><span class="k">' + esc(q.label) + ':</span> ' + esc(v) + '</p>' + trLine(l, col(q)) : '';
        }).join('') +
        (hasIssue(l) && !l.handled ? '<div class="issue-actions">' +
          '<span class="owner-tag' + (l.owner ? '' : ' none') + '" title="' + (l.owner ? 'Assigned to ' + esc(l.owner) : 'Not assigned yet') + '">' + (l.owner ? esc(l.owner) : 'Unassigned') + '</span>' +
          '<button type="button" class="secondary small" data-assignissue="' + l.row + '" data-ts="' + esc(l.when) + '" data-kind="' + G.kind + '" data-owner="' + esc(l.owner) + '">Assign</button>' +
          '<button type="button" class="secondary small" data-resolve="' + l.row + '" data-ts="' + esc(l.when) + '" data-kind="' + G.kind + '">Handled?</button></div>' : '') +
        (l.handled ? '<p class="handled-note">Handled ' + esc(l.handledWhen) + (l.handledNote ? ': ' + esc(l.handledNote) : '') +
          ' <button type="button" class="link" data-reopen="' + l.row + '" data-ts="' + esc(l.when) + '" data-kind="' + G.kind + '">Reopen</button></p>' : '') +
        '</td></tr>';
    };
    var L_SORTABLE = ['title', 'when', 'sent', G.overall];               // sort by session, when, sent, overall rating only
    var lth = function (k, label, numCol) {
      if (L_SORTABLE.indexOf(k) === -1) return '<th class="' + (numCol ? 'num' : '') + '">' + esc(label) + '</th>';
      var sorted = G.sortBy === k ? ' aria-sort="' + (G.sortDir > 0 ? 'ascending' : 'descending') + '"' : '';
      return '<th class="' + (numCol ? 'num' : '') + '"><button type="button" data-lsort="' + esc(k) + '"' + sorted + '>' + esc(label) + '</button></th>';
    };
    var head = '<thead><tr>' + lth('title', 'Session') + lth('when', 'When') + lth('name', G.who) + lth('sent', 'Sent') +
      G.ratings.map(function (q) { return lth(col(q), q.label, 1); }).join('') + lth('issue', 'Comments') + '</tr></thead>';
    if (G.solvedOnly) {
      var solved = list.filter(function (l) { return hasIssue(l) && l.handled; });
      html += '<h2 class="section">Solved issues</h2>' + (solved.length
        ? '<div class="tbl-wrap"><table class="tbl">' + head + '<tbody>' + solved.map(row).join('') + '</tbody></table></div>'
        : '<p class="empty">No key issues marked as handled yet' + (G.filterVal ? ' for ' + esc(G.filterVal) : '') + '.</p>');
      $('tab-' + G.tab).innerHTML = html;
      return;
    }
    if (issues.length) {
      // Filter the open key issues by who they're assigned to; each shows how many
      var nOf = function (o) { return issues.filter(function (l) { return o === '-' ? !l.owner : l.owner === o; }).length; };
      var chip = function (val, label, n) {
        return '<button type="button" class="owner-chip" data-ownerfilter="' + esc(val) + '" data-g="' + G.kind + '" aria-pressed="' + (G.ownerFilter === val) + '">' +
          esc(label) + (n ? ' <span class="count warn">' + n + '</span>' : ' <span class="count zero">0</span>') + '</button>';
      };
      var shownIssues = G.ownerFilter ? issues.filter(function (l) { return G.ownerFilter === '-' ? !l.owner : l.owner === G.ownerFilter; }) : issues;
      html += '<h2 class="section">Key issues to look at</h2><div class="owner-chips" role="group" aria-label="Show key issues assigned to">' +
        chip('', 'All', issues.length) + chip('-', 'Unassigned', nOf('-')) + OWNERS.map(function (o) { return chip(o, o, nOf(o)); }).join('') + '</div>' +
        (shownIssues.length ? '<div class="tbl-wrap"><table class="tbl">' + head + '<tbody>' + shownIssues.map(row).join('') + '</tbody></table></div>'
          : '<p class="empty">No open key issues ' + (G.ownerFilter === '-' ? 'without an owner' : 'assigned to ' + esc(G.ownerFilter)) + '.</p>');
    }
    html += '<h2 class="section">All ' + (G === PG ? 'panel' : 'leader') + ' reports</h2>' + (list.length
      ? '<div class="tbl-wrap"><table class="tbl">' + head + '<tbody>' + list.map(row).join('') + '</tbody></table></div>'
      : '<p class="empty">No ' + G.reports + ' yet. The form is at <strong>' + G.form + '</strong>.</p>');
    $('tab-' + G.tab).innerHTML = html;
  }

  /* ---------- per-speaker ratings ("Jane Doe: 4; John Roe: 5") ---------- */

  function speakerScores(list) {
    var by = {}, order = [];
    if (!SPEAKERQ || !SPEAKERQ.detailColumn) return [];
    list.forEach(function (r) {
      String(r.raw[SPEAKERQ.detailColumn] || '').split(/\s*;\s*/).forEach(function (part) {
        var m = part.match(/^(.*\S)\s*:\s*([1-5](?:\.\d)?)$/);
        if (!m) return;
        // "A and B" was one entry in the session list before 22 Oct: the rating counts for both people
        m[1].split(/\s+and\s+|\s*&\s*/).forEach(function (nm) {
          nm = nm.trim(); if (!nm) return;
          if (!by[nm]) { by[nm] = []; order.push(nm); }
          by[nm].push(+m[2]);
        });
      });
    });
    return order.map(function (nm) { return { name: nm, avg: mean(by[nm]), n: by[nm].length }; });
  }
  // Values for a star breakdown: for the per-speaker question, every individual speaker rating
  // (a response rating two speakers 3 and 4 adds one 3 and one 4); otherwise whole-star answers.
  function starValues(list, q) {
    var out = [];
    list.forEach(function (r) {
      if (q.type === 'speakers' && q.detailColumn && String(r.raw[q.detailColumn] || '').trim()) {
        String(r.raw[q.detailColumn]).split(/\s*;\s*/).forEach(function (part) {
          var m = part.match(/:\s*([1-5])$/); if (m) out.push(+m[1]);
        });
      } else {
        var v = num(r.raw[col(q)]); if (v != null) out.push(Math.round(v));
      }
    });
    return out;
  }

  function speakerLine(list) {
    var sc = speakerScores(list);
    if (!sc.length) return '';
    return '<div class="by-speaker"><span class="k">By speaker:</span> ' + sc.map(function (x) {
      return '<span>' + esc(x.name) + ' <strong>' + fmt1(x.avg) + '</strong> <small>(' + x.n + ')</small></span>';
    }).join(' · ') + '</div>';
  }

  /* ---------- workshops: the same session run more than once ---------- */

  // Same title + same speakers = the same workshop (speaker order ignored).
  // Sessions without named speakers (Open Discussion, TBC slots) are never grouped.
  function workshopKey(s) {
    var people = String(s.speakers || '').toLowerCase().split(/\s*,\s*/).filter(Boolean).sort().join('|');
    if (!people) return 'one:' + s.id;
    return String(s.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '#' + people;
  }
  function workshopsOf(sessionList) {
    var map = {}, out = [];
    sessionList.slice().sort(function (a, b) { return (a.date + a.start + a.room).localeCompare(b.date + b.start + b.room); })
      .forEach(function (s) {
        var k = workshopKey(s);
        if (!map[k]) { map[k] = { key: k, title: s.title, speakers: s.speakers, runs: [] }; out.push(map[k]); }
        map[k].runs.push(s);
      });
    return out;
  }
  function runLabel(s) { return dayLabel(s.date) + ', ' + s.start + ' · ' + s.room; }
  function diff(a, b) {
    if (a == null || b == null) return '';
    var d = Math.round((a - b) * 10) / 10;
    return d === 0 ? '' : ' <span class="diff ' + (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '+' : '') + d.toFixed(1) + '</span>';
  }

  // One card per workshop: combined results, then how each run compared, then comments per run
  function workshopCard(w, byRun, inc) {
    var all = [];
    w.runs.forEach(function (s) { all = all.concat(byRun[s.id] || []); });
    var st = statsFor(all), multi = w.runs.length > 1;
    var i = (state.cardShown || []).indexOf(w);
    var html = '<article class="card" data-workshop="' + esc(w.key) + '"><h3>' + esc(w.title) + '</h3>' +
      (i > -1 ? '<div class="card-actions no-print"><button type="button" class="secondary small" data-copyai="' + i + '" title="Copy all results as text, to paste into an AI tool">Copy for AI</button>' +
        '<button type="button" class="secondary small" data-xlsx="' + i + '" title="Every response for this session as an Excel file">Excel</button></div>' : '') +
      '<div class="meta">' +
      esc(w.speakers || '') + (w.speakers ? ' · ' : '') + (multi ? 'Ran ' + w.runs.length + ' times · ' : esc(runLabel(w.runs[0])) + ' · ') +
      '<strong>' + st.n + ' response' + (st.n === 1 ? '' : 's') + '</strong>' +
      (st.n ? ' \u00b7 ' + pct(all.filter(function (r) { return commentText(r).trim(); }).length, st.n) + ' left a comment' : '') + '</div>';
    if (multi) {
      html += '<div class="qname">How each run compared</div><div class="tbl-wrap compare"><table class="tbl"><thead><tr><th>Run</th><th class="num">Responses</th>' +
        RATINGS.map(function (q) { return '<th class="num">' + esc(col(q).replace(' (1-5)', '')) + '</th>'; }).join('') +
        (PRACTICE ? '<th class="num">' + esc(PRACTICE_SHORT) + '</th>' : '') + '</tr></thead><tbody>' +
        w.runs.map(function (s, i) {
          var rs = statsFor(byRun[s.id] || []);
          return '<tr><td>Run ' + (i + 1) + ': ' + esc(runLabel(s)) + '</td><td class="num">' + rs.n + '</td>' +
            rs.avgs.map(function (a, j) { return '<td class="num">' + fmt1(a) + diff(a, st.avgs[j]) + '</td>'; }).join('') +
            (PRACTICE ? '<td class="num">' + pct(rs.practiceYes, rs.practiceN) + '</td>' : '') + '</tr>';
        }).join('') +
        '<tr class="total"><td>All runs</td><td class="num">' + st.n + '</td>' + st.avgs.map(function (a) { return '<td class="num">' + fmt1(a) + '</td>'; }).join('') +
        (PRACTICE ? '<td class="num">' + pct(st.practiceYes, st.practiceN) + '</td>' : '') + '</tr></tbody></table></div>' +
        '<p class="few">Small numbers next to a run show how it differed from the all-runs average.</p>';
    }
    html += w.runs.map(function (s) {
      return leaderBlock(s, multi ? 'Run ' + (w.runs.indexOf(s) + 1) + ': ' : '', inc);
    }).join('');
    if (!all.length) return html + '<p class="empty">No attendee feedback yet.</p></article>';
    html += '<div class="qname">' + (multi ? 'All runs together' : 'Scores') + '</div><div class="row">' + RATINGS.map(function (q, i) {
      var vals = starValues(all, q);
      var counts = [5, 4, 3, 2, 1].map(function (n) { return vals.filter(function (v) { return v === n; }).length; });
      var mx = Math.max.apply(null, counts.concat(1));
      var label = q.type === 'speakers' ? (q.generalLabel || 'Speakers') : q.label;
      return '<div><div class="qname">' + esc(label) + '</div><div class="avg">' + fmt1(st.avgs[i]) + ' <small>/ 5 · ' + vals.length + ' ratings</small></div>' +
        '<div class="dist">' + counts.map(function (c, k) {
          return '<span>' + (5 - k) + '★</span><span class="b"><i style="width:' + (c / mx * 100) + '%"></i></span><span class="n">' + c + '</span>';
        }).join('') + '</div>' + (q.type === 'speakers' ? speakerLine(all) : '') + '</div>';
    }).join('') + CHOICES.map(function (q) {
      var vals = all.map(function (r) { return r.raw[col(q)]; }).filter(Boolean);
      var mx = Math.max.apply(null, q.options.map(function (o) { return vals.filter(function (v) { return v === o; }).length; }).concat(1));
      return '<div><div class="qname">' + esc(q.label) + '</div><div class="dist" style="grid-template-columns: 110px 1fr 40px">' +
        q.options.map(function (o) {
          var c = vals.filter(function (v) { return v === o; }).length;
          return '<span>' + esc(o) + '</span><span class="b"><i style="width:' + (c / mx * 100) + '%"></i></span><span class="n">' + c + '</span>';
        }).join('') + '</div></div>';
    }).join('') + '</div>';
    html += TEXTS.map(function (q) {
      var total = 0;
      var parts = w.runs.map(function (s, i) {
        var rs = (byRun[s.id] || []).filter(function (r) { return String(r.raw[col(q)] || '').trim(); });
        total += rs.length;
        if (!rs.length) return '';
        return (multi ? '<div class="runhead">Run ' + (i + 1) + ': ' + esc(runLabel(s)) + '</div>' : '') +
          '<ul>' + rs.map(function (r) { return '<li>' + esc(String(r.raw[col(q)]).trim()) + trLine(r, col(q)) + '</li>'; }).join('') + '</ul>';
      }).join('');
      return '<div class="qname">' + esc(q.label) + ' <span class="few">(' + total + ')</span></div>' + (total ? parts : '<p class="few">None.</p>');
    }).join('');
    return html + '</article>';
  }

  function scorecardData() {
    var list = fRows(), byRun = {};
    list.forEach(function (r) { if (!r.typed) (byRun[r.id] = byRun[r.id] || []).push(r); });
    var withLeader = {}; (state.withLeaders ? leaders : []).concat(state.withPanel ? panel : []).forEach(function (l) { withLeader[baseId(l.id)] = 1; });
    var ws = workshopsOf(fSessions()).filter(function (w) { return w.runs.some(function (s) { return byRun[s.id] || withLeader[s.id]; }); });
    return { byRun: byRun, ws: ws };
  }

  function renderScorecards() {
    var sd = scorecardData(), ws = sd.ws;
    if (state.scorecard) {                      // came from a session link elsewhere: select its workshop
      var hit = ws.filter(function (w) { return w.runs.some(function (s) { return s.id === state.scorecard; }); })[0];
      if (hit) state.picked = [hit.key];
      state.scorecard = '';
    }
    // Everything shown is exported (use the day / track / room filters to narrow it).
    // Clicking a session elsewhere opens just that one, with a way back to all.
    var picked = (state.picked || []).filter(function (k) { return ws.some(function (w) { return w.key === k; }); });
    var show = picked.length ? ws.filter(function (w) { return picked.indexOf(w.key) > -1; }) : ws;
    var html = '<div class="controls no-print export-bar">' +
      '<span><strong>' + show.length + '</strong> ' + (show.length === 1 ? 'session' : 'sessions') + ' shown' +
      (picked.length ? ' · <button type="button" class="link" id="pickNone">Show all ' + ws.length + '</button>' : ' (repeat runs combined)') + '</span>' +
      '<label class="toggle"><input type="checkbox" id="withLeaders"' + (state.withLeaders ? ' checked' : '') + '> Include Session Leader reports</label>' +
      '<label class="toggle"><input type="checkbox" id="withPanel"' + (state.withPanel ? ' checked' : '') + '> Include Advisory Panel reports</label>' +
      onlineToggle() +
      '<button type="button" class="secondary small" id="scoreExportBtn">Export</button></div>';
    state.cardShown = show;                     // the Copy for AI / Excel buttons on each card look it up here
    html += show.length ? show.map(function (w) { return workshopCard(w, sd.byRun, included()); }).join('')
      : '<p class="empty">No sessions with feedback match these filters.</p>';
    $('tab-scorecards').innerHTML = html;
  }


  /* ---------- Word export (editable before sending to speakers) ---------- */

  // Every Session Leader's key takeaway, by day and time, as an Excel file (follows the filters)
  function exportTakeaways() {
    var list = leaders.filter(function (l) { return String(l.raw[L_TAKEAWAY] || '').trim() && matches(l, l.name + ' ' + l.raw[L_TAKEAWAY]); })
      .sort(function (a, b) { return (a.date + a.start + a.room).localeCompare(b.date + b.start + b.room); });
    if (!list.length) { alert('No key takeaways yet with these filters.'); return; }
    var btn = $('takeawaysBtn'), label = btn.innerHTML; btn.disabled = true; btn.textContent = 'Preparing…';
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js').then(function () {
      var X = window.XLSX;
      var rowsX = [['Day', 'Time', 'Room', 'Session', 'Speakers', 'Type', 'Track', 'Session Leader', 'Key takeaway']].concat(list.map(function (l) {
        var s = byId[l.id] || {};
        return [dayLabel(l.date), l.start + (s.end ? '\u2013' + s.end : ''), l.room, l.title, l.speakers, l.type, l.track, l.name, String(l.raw[L_TAKEAWAY]).replace(/^'/, '')];
      }));
      var ws = X.utils.aoa_to_sheet(rowsX);
      ws['!cols'] = [10, 12, 14, 44, 34, 16, 30, 18, 80].map(function (w) { return { wch: w }; });
      ws['!autofilter'] = { ref: 'A1:I1' };
      var wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, ws, 'Key takeaways');
      X.writeFile(wb, 'IFC2026 key takeaways' + ($('showTest').checked ? ' (TEST)' : '') + '.xlsx');
    }).catch(function () {
      alert(coded('Could not create the Excel file (no connection to the export library). Try again.', 'D204'));
    }).then(function () { btn.disabled = false; btn.innerHTML = label; closeExport(); });
  }

  function loadScript(src) {
    return new Promise(function (ok, bad) {
      if (document.querySelector('script[src="' + src + '"]')) return ok();
      var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s);
    });
  }

  function exportWord() {
    var sd = scorecardData();
    var picked = (state.picked || []);
    var ws = picked.length ? sd.ws.filter(function (w) { return picked.indexOf(w.key) > -1; }) : sd.ws;
    if (!ws.length) { alert('Nothing to export with these filters.'); return; }
    var many = ws.length > 1;
    var oneDoc = !many || !$('wZip').checked;
    var btn = $('wordGo'), label = btn.innerHTML; btn.disabled = true; btn.textContent = 'Preparing…';
    var libs = loadScript('https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js')
      .then(function () { return many && !oneDoc ? loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js') : null; });
    libs.then(function () {
      var D = window.docx;
      var fname = function (w) { return 'IFC2026 feedback - ' + w.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80) + '.docx'; };
      var build = function (list) {
        var children = [];
        list.forEach(function (w, i) { children = children.concat(docxWorkshop(D, w, sd.byRun, included(), i > 0)); });
        return new D.Document({
          creator: 'IFC 2026 feedback dashboard', title: 'IFC 2026 session feedback',
          styles: { default: { document: { run: { font: 'Arial', size: 21 } } } },
          sections: [{ children: children }]
        });
      };
      if (oneDoc) {
        return D.Packer.toBlob(build(ws)).then(function (blob) { save(blob, many ? 'IFC2026 session feedback (' + ws.length + ').docx' : fname(ws[0])); });
      }
      var zip = new window.JSZip();
      return Promise.all(ws.map(function (w) {
        return D.Packer.toBlob(build([w])).then(function (blob) { zip.file(fname(w), blob); });
      })).then(function () { return zip.generateAsync({ type: 'blob' }); })
        .then(function (blob) { save(blob, 'IFC2026 session feedback (' + ws.length + ' files).zip'); });
    }).catch(function (e) {
      alert(coded('Could not create the Word file (' + (e && e.message || 'no connection to the export library') + '). Try again.', 'D203'));
    }).then(function () { btn.disabled = false; btn.innerHTML = label; closeExport(); });
  }

  function save(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  // Plain, tidy Word content: headings, a comparison table, score summaries, comments as bullet points
  function docxWorkshop(D, w, byRun, inc, newPage) {
    var P = function (text, opt) { return new D.Paragraph(Object.assign({ children: [new D.TextRun(Object.assign({ text: String(text) }, (opt && opt.run) || {}))] }, opt && opt.para || {})); };
    var cell = function (text, bold) { return new D.TableCell({ children: [P(text, { run: { bold: !!bold } })] }); };
    var all = [];
    w.runs.forEach(function (s) { all = all.concat(byRun[s.id] || []); });
    var st = statsFor(all), multi = w.runs.length > 1, out = [];
    out.push(P('IFC 2026 · Session feedback', { para: { pageBreakBefore: newPage }, run: { color: 'A85300', bold: true, size: 18 } }));
    out.push(P(w.title, { para: { heading: D.HeadingLevel.HEADING_1 } }));
    if (w.speakers) out.push(P(w.speakers, { run: { italics: true } }));
    out.push(P((multi ? 'Ran ' + w.runs.length + ' times: ' + w.runs.map(runLabel).join('; ') : runLabel(w.runs[0])) + ' · ' + st.n + ' responses'));
    out.push(P(''));
    if (multi) {
      out.push(P('How each run compared', { para: { heading: D.HeadingLevel.HEADING_2 } }));
      var head = ['Run', 'Responses'].concat(RATINGS.map(function (q) { return col(q).replace(' (1-5)', ''); })).concat(PRACTICE ? [PRACTICE_SHORT] : []);
      var rowsT = [new D.TableRow({ tableHeader: true, children: head.map(function (h) { return cell(h, true); }) })];
      w.runs.forEach(function (s, i) {
        var rs = statsFor(byRun[s.id] || []);
        rowsT.push(new D.TableRow({ children: [cell('Run ' + (i + 1) + ': ' + runLabel(s)), cell(rs.n)].concat(rs.avgs.map(function (a) { return cell(fmt1(a)); }))
          .concat(PRACTICE ? [cell(pct(rs.practiceYes, rs.practiceN))] : []) }));
      });
      rowsT.push(new D.TableRow({ children: [cell('All runs', true), cell(st.n, true)].concat(st.avgs.map(function (a) { return cell(fmt1(a), true); }))
        .concat(PRACTICE ? [cell(pct(st.practiceYes, st.practiceN), true)] : []) }));
      out.push(new D.Table({ rows: rowsT, width: { size: 100, type: D.WidthType.PERCENTAGE } }));
      out.push(P(''));
    }
    out.push(P(multi ? 'Scores (all runs together)' : 'Scores', { para: { heading: D.HeadingLevel.HEADING_2 } }));
    RATINGS.forEach(function (q, i) {
      var vals = starValues(all, q);
      var counts = [5, 4, 3, 2, 1].map(function (n) { return n + '★ ' + vals.filter(function (v) { return v === n; }).length; }).join('   ');
      var label = q.type === 'speakers' ? (q.generalLabel || 'Speakers') : q.label;
      out.push(new D.Paragraph({ children: [new D.TextRun({ text: label + '  ', bold: true }), new D.TextRun({ text: fmt1(st.avgs[i]) + ' / 5 (' + vals.length + ' ratings)' })] }));
      out.push(P(counts, { run: { color: '545454', size: 18 } }));
      if (q.type === 'speakers') speakerScores(all).forEach(function (x) {
        out.push(new D.Paragraph({ bullet: { level: 0 }, children: [new D.TextRun({ text: x.name + ': ' }), new D.TextRun({ text: fmt1(x.avg) + ' / 5', bold: true }), new D.TextRun({ text: ' (' + x.n + ' ratings)' })] }));
      });
    });
    CHOICES.forEach(function (q) {
      var vals = all.map(function (r) { return r.raw[col(q)]; }).filter(Boolean);
      out.push(new D.Paragraph({ children: [new D.TextRun({ text: q.label + '  ', bold: true }),
        new D.TextRun({ text: q.options.map(function (o) { return o + ': ' + vals.filter(function (v) { return v === o; }).length; }).join(' · ') })] }));
    });
    TEXTS.forEach(function (q) {
      out.push(P(q.label, { para: { heading: D.HeadingLevel.HEADING_2 } }));
      var any = false;
      w.runs.forEach(function (s, i) {
        // with the English translation in brackets when the answer was in another language
        var vals = (byRun[s.id] || []).map(function (r) {
          var t = String(r.raw[col(q)] || '').trim(), en = String(r.raw[col(q) + ' (English)'] || '').replace(/^'/, '').trim();
          return t && en ? t + ' (English: ' + en + ')' : t;
        }).filter(Boolean);
        if (!vals.length) return;
        any = true;
        if (multi) out.push(P('Run ' + (i + 1) + ': ' + runLabel(s), { run: { bold: true, size: 19 } }));
        vals.forEach(function (v) { out.push(new D.Paragraph({ text: v, bullet: { level: 0 } })); });
      });
      if (!any) out.push(P('None.', { run: { italics: true } }));
    });
    [[LG, leaders, 'Session Leader reports (internal)', inc.leaders], [PG, panel, 'Advisory Panel reports (internal)', inc.panel]].forEach(function (g) {
      if (!g[3]) return;
      var G = g[0], ls = g[1].filter(function (l) { return w.runs.some(function (s) { return sameSession(l, s); }); });
      if (!ls.length) return;
      out.push(P(g[2], { para: { heading: D.HeadingLevel.HEADING_2 } }));
      ls.forEach(function (l) {
        var s = byId[l.id];
        out.push(P((l.name || G.who) + (s ? ' · ' + runLabel(s) : /-P1$/.test(l.id) ? ' · Part 1' : ''), { run: { bold: true } }));
        out.push(P(G.ratings.map(function (q) { return q.label + ': ' + (num(l.raw[col(q)]) || '–') + '/5'; }).join(' · ')));
        G.texts.forEach(function (q) { if (l.raw[col(q)]) out.push(P(q.label + ': ' + l.raw[col(q)])); });
      });
    });
    out.push(P(''));
    out.push(P('Feedback was given anonymously by IFC 2026 attendees.', { run: { italics: true, color: '545454', size: 18 } }));
    return out;
  }


  /* ---------- typed in ("My session isn't listed") ---------- */

  // Everything typed in: attendees, plus Session Leader and Advisory Panel reports (with the person's name)
  function typedItems() {
    var tag = function (list, kind, who) {
      return list.map(function (x) { return { x: x, kind: kind, who: who ? who + ': ' + (x.name || '?') : '', overall: kind === 'panel' ? PG.overall : kind === 'leader' ? L_OVERALL : OVERALL }; });
    };
    return tag(rows, 'attendee', '').concat(tag(leaders, 'leader', 'Session Leader'), tag(panel, 'panel', 'Advisory Panel'))
      .sort(function (a, b) { return String(b.x.when).localeCompare(String(a.x.when)); });
  }
  function typedText(it) {
    var x = it.x, texts = it.kind === 'attendee' ? TEXTS : (it.kind === 'panel' ? PG.texts : LG.texts);
    return texts.map(function (q) { return x.raw[col(q)] ? '<div class="t-sub">' + esc(q.label || col(q)) + ': ' + esc(x.raw[col(q)]) + '</div>' : ''; }).join('');
  }
  function whoLine(it) { return it.who ? '<div class="t-who">' + esc(it.who) + '</div>' : ''; }

  function renderTyped() {
    var items = typedItems();
    var all = items.filter(function (it) { return it.x.id === 'NOT LISTED'; });
    var dismissed = all.filter(function (it) { return /no match/i.test(it.x.raw.Note || ''); });
    var list = all.filter(function (it) { return dismissed.indexOf(it) === -1; });
    var history = items.filter(function (it) { return /matched on dashboard/.test(it.x.raw.Note || ''); });
    $('typedCount').textContent = list.length || '';
    var html = '<p class="sub">Answers from people who could not find their session and typed it in. ' +
      'Use these to spot a missing or misnamed session in the Sessions tab.</p>';
    if (history.length) html += '<p class="sub">' + history.length + ' already matched to a session (they now count in that session\'s results). ' +
      '<button type="button" class="link" id="jumpHistory">See the match history</button></p>';
    var attrs = function (it) { return ' data-ts="' + esc(it.x.when) + '" data-kind="' + it.kind + '"'; };
    html += list.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>What they typed</th><th class="num">Overall</th>' +
      '<th>Match to session</th></tr></thead><tbody>' +
      list.map(function (it) {
        var r = it.x, guess = bestGuess(r.title);
        return '<tr><td>' + esc(localTime(r.when)) + '</td><td class="t-title">' + whoLine(it) + esc(r.title) + typedText(it) +
          '</td><td class="num">' + (num(r.raw[it.overall]) || '–') + '</td>' +
          '<td class="assign"><select data-row="' + r.row + '" data-kind="' + it.kind + '" aria-label="Session for this response">' + sessionOptions(guess) + '</select>' +
          (guess ? '<div class="t-sub assign-hint">Best guess pre-selected. Check it before matching.</div>' : '') +
          '<div class="assign-actions"><button type="button" class="secondary small" data-assign="' + r.row + '"' + attrs(it) + '>Match</button>' +
          '<button type="button" class="link" data-nomatch="' + r.row + '"' + attrs(it) + '>No match</button></div></td></tr>';
      }).join('') + '</tbody></table></div>'
      : '<p class="empty">Nothing waiting to be matched.' + (history.length ? '' : ' Good sign: the list is complete.') + '</p>';
    if (dismissed.length) {
      html += '<details class="dismissed"><summary>' + dismissed.length + ' marked "no match" (still kept in the database)</summary>' +
        '<div class="tbl-wrap"><table class="tbl"><tbody>' + dismissed.map(function (it) {
          var r = it.x;
          return '<tr><td>' + esc(localTime(r.when)) + '</td><td class="t-title">' + whoLine(it) + esc(r.title) + '</td><td class="num">' + (num(r.raw[it.overall]) || '–') + '</td>' +
            '<td><button type="button" class="link" data-restore="' + r.row + '"' + attrs(it) + '>Restore</button></td></tr>';
        }).join('') + '</tbody></table></div></details>';
    }
    // Match history: what people typed, and the session it was matched to
    html += '<h2 class="section" id="typedHistory">Match history</h2>' + (history.length
      ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>What they typed</th><th>Matched to</th></tr></thead><tbody>' +
        history.map(function (it) {
          var r = it.x, m = String(r.raw.Note).match(/^Typed in as "(.*)", matched on dashboard$/);
          return '<tr><td>' + esc(localTime(r.when)) + '</td><td class="t-title">' + whoLine(it) + esc(m ? m[1] : '') + '</td>' +
            '<td><button type="button" class="linkish" data-card="' + esc(baseId(r.id)) + '">' + esc(r.title) + '</button>' +
            '<div class="t-sub">' + esc([dayLabel(r.date) + (r.start ? ', ' + r.start : ''), r.room].filter(Boolean).join(' · ')) + '</div></td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<p class="empty">Nothing matched yet. Matches you make above are listed here.</p>');
    $('tab-typed').innerHTML = html;
  }


  // Session picker grouped by day and time
  function sessionOptions(selectedId) {
    var groups = {};
    sessions.slice().sort(function (a, b) { return (a.date + a.start + a.room).localeCompare(b.date + b.start + b.room); })
      .forEach(function (s) { var k = dayLabel(s.date) + ', ' + s.start; (groups[k] = groups[k] || []).push(s); });
    return '<option value="">Choose a session…</option>' + Object.keys(groups).map(function (k) {
      return '<optgroup label="' + esc(k) + '">' + groups[k].map(function (s) {
        return '<option value="' + esc(s.id) + '"' + (s.id === selectedId ? ' selected' : '') + '>' + esc(s.title + ' · ' + s.room) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
  }

  // Simple word-overlap guess at which session someone meant
  var GUESS_STOP = ['the', 'one', 'and', 'about', 'session', 'talk', 'workshop', 'room', 'big', 'with', 'from',
                    'for', 'that', 'this', 'was', 'were', 'what', 'on', 'in', 'of', 'a', 'an'];
  function words(t) {
    return String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/)
      .filter(function (w) { return w.length > 2 && GUESS_STOP.indexOf(w) === -1; });
  }
  function bestGuess(text) {
    var typed = words(text);
    var best = null, score = 0, tie = false;
    sessions.forEach(function (s) {
      var title = words(s.title), people = words(s.speakers), sc = 0;
      typed.forEach(function (w) {
        var hit = function (h) { return h === w || (w.length >= 4 && (h.indexOf(w) === 0 || w.indexOf(h) === 0) && h.length >= 4); };
        if (title.some(hit)) sc += w.length * 2;          // title words count most
        else if (people.some(hit)) sc += w.length * 2;    // then speaker names
      });
      if (sc > score) { score = sc; best = s.id; tie = false; }
      else if (sc === score && sc > 0) tie = true;
    });
    return score >= 8 ? best : '';     // ties are fine: same session often runs twice, we pick the first
  }

  // Session Leader or Advisory Panel key issue: mark handled (with a note) or reopen. The row goes at once;
  // the save carries on in the background and the row comes back if it fails.
  function resolveIssue(btn, reopen) {
    var note = '';
    if (!reopen) {
      note = prompt('What was done about this? A few words, e.g. "Projector replaced".');
      if (note === null) return;
      note = note.trim();
      if (!note) { alert('Please add a short note so the team knows what happened.'); return; }
    }
    var tr = btn.closest('tr');
    if (tr && !reopen) tr.hidden = true;
    var panelIssue = btn.dataset.kind === 'panel';
    var cnt = $(panelIssue ? 'panelCount' : 'issueCount'); var before = cnt.textContent;
    if (!reopen) cnt.textContent = Math.max(0, (+before || 0) - 1) || '';
    btn.disabled = true;
    fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'resolve', kind: panelIssue ? 'panel' : 'leader', key: state.key, test: $('showTest').checked, row: +(btn.dataset.resolve || btn.dataset.reopen),
        timestamp: btn.dataset.ts, note: note, reopen: !!reopen })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { var err = new Error(j.error || 'not saved'); err.code = j.code; err.answered = true; throw err; }
      load();
    }).catch(function (e) {
      if (tr) tr.hidden = false; cnt.textContent = before; btn.disabled = false;
      if (e.code === 'S127') { alert(coded('Not saved: ' + e.message + '.', 'D201', e.code)); load(); return; }
      alert(e.answered ? coded('Not saved: ' + e.message + '. Please try again.', 'D201', e.code)
                       : coded('Could not reach the database. Please try again.', 'D202'));
    });
  }

  function assign(btn, special) {
    var row = btn.dataset.assign || btn.dataset.nomatch || btn.dataset.restore, sessionId = special;
    if (!special) {
      var sel = document.querySelector('select[data-row="' + row + '"][data-kind="' + (btn.dataset.kind || 'attendee') + '"]');
      if (!sel.value) { sel.focus(); return; }
      var s = byId[sel.value];
      if (!confirm('Match this ' + (btn.dataset.kind === 'leader' ? 'Session Leader report' : btn.dataset.kind === 'panel' ? 'Advisory Panel report' : 'response') + ' to "' + s.title + '" (' + s.room + ', ' + dayLabel(s.date) + ' ' + s.start + ')?\n\nThis updates the database.')) return;
      sessionId = sel.value;
    }
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    // the row goes straight away; it comes back if the save fails
    var tr = btn.closest('tr'), cnt = $('typedCount'), before = cnt.textContent;
    if (tr && special !== '__RESTORE__') { tr.hidden = true; cnt.textContent = Math.max(0, (+before || 0) - 1) || ''; }
    if (tr && special === '__RESTORE__') tr.hidden = true;
    fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'assign', kind: btn.dataset.kind || 'attendee', key: state.key, test: $('showTest').checked, row: +row, timestamp: btn.dataset.ts, sessionId: sessionId })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { if (tr) tr.hidden = false; cnt.textContent = before; alert(coded('Not saved: ' + (j.error || 'unknown problem') + '.', 'D201', j.code)); btn.disabled = false; btn.textContent = label; return; }
      load();
    }).catch(function () { if (tr) tr.hidden = false; cnt.textContent = before; alert(coded('Could not reach the database. Please try again.', 'D202')); btn.disabled = false; btn.textContent = label; });
  }


  /* ---------- page wiring ---------- */

  function renderAll() {
    renderOverview(); renderRankings(); renderComments(); renderLeaders(); renderPanel(); renderOnline(); renderScorecards(); renderTyped(); renderAnalytics();
  }

  function updateStatus() {
    var fresh = state.lastOk && Date.now() - state.lastOk < 3 * REFRESH_MS;
    $('liveDot').classList.toggle('stale', !fresh);
    $('updated').textContent = state.lastOk
      ? (fresh ? 'Live · ' : 'Not updating · ') + 'updated ' + ago(Date.now() - state.lastOk) +
        (fresh && state.data && state.data.viewers ? ' · ' + state.data.viewers + ' viewing' + (state.data.viewers > 1 ? ' (including you)' : ' (just you)') : '') +
        ($('showTest').checked ? ' · showing TEST responses' : '')
      : state.cachedAt ? 'Showing results from ' + ago(Date.now() - state.cachedAt) + ' · updating…' : 'Loading…';

  }

  // Warn if responses are piling up in the Raw log instead of reaching the Sheet tabs
  function healthMessage(h) {
    if (!h) return '';
    if (h.firebase && h.firebase.error) return coded('Copying from Firebase to the database is failing (' + h.firebase.error.slice(25, 140) + '). Responses are safe in Firebase; tell Shawn.', 'S201');
    if (!h.automatic) return coded('Automatic processing is OFF. In the Sheet: IFC Feedback > Turn on automatic processing + hourly backups. (Nothing is lost: responses wait safely in the Raw log.)', 'S202');
    var age = h.lastProcessed ? Date.now() - Date.parse(h.lastProcessed) : Infinity;
    if (h.waiting > 0 && age > 5 * 60000) return coded(h.waiting + ' responses are waiting in the Raw log and processing last ran ' + ago(age) + '. They are safe; check the script triggers.', 'S203');
    var u = h.usage;
    if (u && (u.runMinutes > 70 || u.firebaseReads > 40000)) return coded('Getting close to a daily Google limit: background time ' + u.runMinutes + ' of 90 min, Firebase reads ' + u.firebaseReads + ' of 50,000. Responses are safe; tell Shawn.', u.runMinutes > 70 ? 'S301' : 'S302');
    return '';
  }

  // Every problem message ends with its code(s), e.g. "(Code D201 / S122)". The codes are
  // listed in the on-the-day guide, so anyone can look one up or send it to Shawn.
  function coded(msg) {
    var codes = [].slice.call(arguments, 1).filter(Boolean);
    return codes.length ? msg + ' (Code ' + codes.join(' / ') + ')' : msg;
  }

  function showAlert(msg) { $('alert').textContent = msg; $('alert').hidden = !msg; }

  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('.tabs [role=tab]').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === name); });
    document.querySelectorAll('.panel').forEach(function (p) { p.hidden = p.id !== 'tab-' + name; });
  }

  // Phones show each table row as a card, so every cell needs its column name
  // Phones: column sorting becomes one "Sort by" dropdown above the table (shown by CSS on small screens).
  // Rankings offers only rank, session, when, responses and overall.
  var M_SORT_OK = ['rank', 'title', 'when', 'n', 'avg0'];
  function addMobileSort(t) {
    if (t.dataset.msort) return;
    t.dataset.msort = '1';
    var btns = [].slice.call(t.querySelectorAll('thead th button'));
    if (!btns.length) return;
    var panelBtns = [].slice.call(t.closest('.panel').querySelectorAll('th button'));
    var opts = btns.filter(function (b) { return b.dataset.lsort || M_SORT_OK.indexOf(b.dataset.sort) > -1; });
    if (!opts.length) return;
    var on = btns.filter(function (b) { return b.hasAttribute('aria-sort'); })[0];
    var wrap = document.createElement('label');
    wrap.className = 'm-sort';
    wrap.innerHTML = 'Sort by <select class="m-sort-select">' + opts.map(function (b) {
      return '<option value="' + panelBtns.indexOf(b) + '"' + (b === on ? ' selected' : '') + '>' + esc(b.textContent.trim()) + '</option>';
    }).join('') + (on && opts.indexOf(on) === -1 ? '<option selected disabled>' + esc(on.textContent.trim()) + '</option>' : '') + '</select>';
    t.closest('.tbl-wrap').insertAdjacentElement('beforebegin', wrap);
  }

  function labelTables(root) {
    root.querySelectorAll('table.tbl').forEach(function (t) {
      addMobileSort(t);
      var heads = [].map.call(t.querySelectorAll('thead th'), function (th) { return th.textContent.trim(); });
      t.querySelectorAll('tbody tr').forEach(function (tr) {
        [].forEach.call(tr.children, function (td, i) {
          if (!heads[i] || td.hasAttribute('data-label')) return;
          td.setAttribute('data-label', heads[i]);
          var box = document.createElement('div');                       // keeps the cell's contents together beside its label
          box.className = 'cell';
          while (td.firstChild) box.appendChild(td.firstChild);
          td.appendChild(box);
        });
      });
    });
  }
  if (window.MutationObserver) {
    new MutationObserver(function () { labelTables(document); })
      .observe(document.getElementById('app'), { childList: true, subtree: true });
  }

  // The password stays in the address bar (after #) so the link can be copied and shared as a
  // sign-in link. The part after # is never sent to any server.
  function showKeyInUrl(key) {
    history.replaceState(null, '', location.pathname + location.search + (key ? '#' + encodeURIComponent(key) : ''));
  }

  function signOut(msg) {
    state.key = null;
    store('local', KEY_STORE, null); store('session', KEY_STORE, null);
    store('local', 'ifc26-dash-cache-real', null); store('local', 'ifc26-dash-cache-test', null);
    state.sig = null; state.cachedAt = null;
    showKeyInUrl('');
    $('app').hidden = true; $('login').hidden = false;
    $('loginError').textContent = msg || '';
    $('pw').value = ''; $('pw').focus();
  }

  function loadingPanels() {
    if (state.data) return;                                        // something is already on screen
    ['overview', 'scorecards', 'rankings', 'leaders', 'panel', 'online', 'comments', 'typed', 'analytics'].forEach(function (t) {
      $('tab-' + t).innerHTML = '<p class="empty loading-note">Loading the latest results\u2026 This can take up to 10 seconds.</p>';
    });
  }

  var timer = null;
  function start() {
    $('login').hidden = true; $('app').hidden = false;
    showCached(); updateStatus();
    load();
    clearInterval(timer);
    timer = setInterval(function () { if (document.visibilityState === 'visible') load(); else updateStatus(); }, REFRESH_MS);
  }

  function init() {
    if (!API) { $('login').hidden = false; $('loginError').textContent = coded('No database address in config.js yet.', 'D104'); return; }
    // A sign-in link carries the password after #, which never leaves the browser.
    // It is remembered on this device and stays in the address bar, so the link can be shared.
    if (location.hash.length > 1) {
      try { state.key = decodeURIComponent(location.hash.slice(1)); } catch (e) { state.key = location.hash.slice(1); }
      store('local', KEY_STORE, state.key);
    }
    // ?test in the link opens with test responses showing (for demos to the team)
    // DEMO PERIOD: test responses show by default so the dashboard looks lived-in when shown
    // to people. Untick "Show test responses" for real feedback, or open the link with ?real.
    // Set SHOW_TEST_BY_DEFAULT to false (or remove test mode) before the conference.
    var SHOW_TEST_BY_DEFAULT = false;              // 19 Oct: demos done, real responses by default (?test still opens test)
    $('showTest').checked = /[?&]test(=|&|$)/.test(location.search) || (SHOW_TEST_BY_DEFAULT && !/[?&]real(=|&|$)/.test(location.search));
    $('testBanner').hidden = !$('showTest').checked;
    state.key = state.key || store('session', KEY_STORE) || store('local', KEY_STORE);
    if (state.key) { showKeyInUrl(state.key); start(); } else $('login').hidden = false;
    var help = $('pwHelp');                                      // address put together here, not sitting in the page
    if (help) help.href = 'mailto:' + ['shawnlifebiz', 'gmail.com'].join('@') + '?subject=' + encodeURIComponent('IFC 2026 dashboard password');

    $('login').addEventListener('submit', function (e) {
      e.preventDefault();
      var key = $('pw').value;
      $('loginBtn').disabled = true; $('loginError').textContent = '';
      state.key = key;
      fetchData().then(function (d) {
        $('loginBtn').disabled = false;
        if (d.stale) { $('loginBtn').disabled = false; return; }
        if (!d.ok) { $('loginError').textContent = coded(d.message || 'That password did not work.', d.code); return; }
        store('local', KEY_STORE, key);                          // always remembered on this device
        showKeyInUrl(key);
        state.lastOk = Date.now();
        $('login').hidden = true; $('app').hidden = false;
        show(d); saveCache(d); updateStatus();
        clearInterval(timer);
        timer = setInterval(function () { if (document.visibilityState === 'visible') load(); else updateStatus(); }, REFRESH_MS);
      }).catch(function () {
        $('loginBtn').disabled = false;
        $('loginError').textContent = coded('Could not reach the database. Check your connection and try again.', 'D103');
      });
    });

    $('logoutBtn').addEventListener('click', function () { clearInterval(timer); signOut(''); });
    $('refreshBtn').addEventListener('click', load);
    $('showTest').addEventListener('change', function () {
      state.lastOk = 0; state.cachedAt = null;
      $('testBanner').hidden = !$('showTest').checked;
      if (!showCached()) {
        state.data = null; state.sig = null;
        ['overview', 'scorecards', 'rankings', 'leaders', 'panel', 'online', 'comments', 'typed', 'analytics'].forEach(function (t) {
          $('tab-' + t).innerHTML = '<p class="empty">Loading ' + ($('showTest').checked ? 'test' : 'real') + ' responses…</p>';
        });
      }
      updateStatus();
      load();
    });
    ['fDay', 'fType', 'fTrack', 'fRoom'].forEach(function (id) { $(id).addEventListener('change', renderAll); });
    document.addEventListener('focusout', function () {
      setTimeout(function () { if (pendingRender && !busyTyping()) { pendingRender = false; renderAll(); } }, 0);
    });
    var t;
    $('fText').addEventListener('input', function () { clearTimeout(t); t = setTimeout(renderAll, 150); });
    document.querySelector('.tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[role=tab]'); if (b) showTab(b.dataset.tab);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && state.key && Date.now() - state.lastOk > REFRESH_MS) load();
    });

    // Clicks inside the panels
    document.querySelector('#app').addEventListener('click', function (e) {
      var el = e.target;
      if (el.dataset.lsort) {
        var k = el.dataset.lsort, G = el.dataset.g === 'panel' ? PG : LG;
        G.sortDir = G.sortBy === k ? -G.sortDir : (k === 'when' || k === 'title' || k === 'name' ? 1 : -1);
        G.sortBy = k; if (G === PG) renderPanel(); else renderLeaders();
      } else if (el.dataset.sort) {
        state.sortDir = state.sortBy === el.dataset.sort ? -state.sortDir : (/^(title|when|rank)$/.test(el.dataset.sort) ? 1 : -1);
        state.sortBy = el.dataset.sort; renderRankings();
      } else if (el.closest('[data-card]')) {
        state.scorecard = el.closest('[data-card]').dataset.card; renderScorecards(); showTab('scorecards'); window.scrollTo(0, 0);
      } else if (el.dataset.toggle) {
        var box = $(el.dataset.toggle); box.hidden = !box.hidden;
        el.textContent = box.hidden ? 'Show as a table' : 'Hide table';
      } else if (el.dataset.assign) assign(el);
      else if (el.dataset.nomatch) assign(el, '__NO_MATCH__');
      else if (el.dataset.resolve) resolveIssue(el, false);
      else if (el.dataset.reopen) resolveIssue(el, true);
      else if (el.dataset.restore) assign(el, '__RESTORE__');
      else if (el.id === 'exportBtn') exportRanking(el);
      else if (el.id === 'scoreExportBtn') openExport('scorecards');
      else if (el.closest('#outstandingBtn')) showOutstanding();
      else if (el.dataset.assignissue) showAssign(el);
      else if (el.closest('[data-ovtab]')) {                          // Overview number: that tab, filtered to that owner's open issues
        var OV = el.closest('[data-ovtab]'), OVG = OV.dataset.ovtab === 'panel' ? PG : LG;
        OVG.ownerFilter = OV.dataset.ovowner || ''; OVG.solvedOnly = false;
        if (OVG === PG) renderPanel(); else renderLeaders();
        showTab(OV.dataset.ovtab);
        var kh = [].slice.call(document.querySelectorAll('#tab-' + OV.dataset.ovtab + ' h2.section')).filter(function (h) { return /key issues/i.test(h.textContent); })[0];
        if (kh) kh.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
      }
      else if (el.dataset.clearid) clearOutstanding([{ id: el.dataset.clearid, name: el.dataset.clearname }], !!el.dataset.undo, el);
      else if (el.id === 'clearAllBtn') {
        var who = $('clearWho').value;
        if (!who) { $('clearWho').focus(); return; }
        var mine = [];
        outstanding().forEach(function (sl) { sl.items.forEach(function (it) { if (it.names.indexOf(who) > -1) mine.push({ id: it.id, name: who }); }); });
        if (confirm('Clear all ' + mine.length + ' outstanding report' + (mine.length === 1 ? '' : 's') + ' for ' + who + '?')) clearOutstanding(mine, false, el);
      }
      else if (el.closest('[data-setowner]')) saveOwner(el.closest('[data-setowner]').dataset.setowner, el.closest('[data-setowner]'));
      else if (el.closest('[data-ownerfilter]')) {
        var OB = el.closest('[data-ownerfilter]'), OG = OB.dataset.g === 'panel' ? PG : LG;
        OG.ownerFilter = OG.ownerFilter === OB.dataset.ownerfilter ? '' : OB.dataset.ownerfilter;   // click again: back to All
        if (OG === PG) renderPanel(); else renderLeaders();
      }
      else if (el.dataset.copyai) copyForAI(el);
      else if (el.dataset.xlsx) sessionExcel(el);
      else if (el.closest('[data-solved]')) {
        var SG = el.closest('[data-solved]').dataset.solved === 'panel' ? PG : LG;
        SG.solvedOnly = !SG.solvedOnly;
        if (SG === PG) renderPanel(); else renderLeaders();
      }
      else if (el.id === 'jumpHistory') $('typedHistory').scrollIntoView({ behavior: 'smooth', block: 'start' });   // not a #link: the address keeps the password after #
      else if (el.id === 'fullExportBtn') openExport('full');
      else if (el.closest('#exSummary')) fullExport(el.closest('#exSummary'), 'summary');
      else if (el.closest('#exFull')) fullExport(el.closest('#exFull'), 'full');
      else if (el.id === 'exportClose' || el.id === 'exportDlg') closeExport();      // the x, or a click on the dark area
      else if (el.closest('#takeawaysBtn')) exportTakeaways();
      else if (el.id === 'moreComments') { state.commentsShown += 100; renderComments(); }
      else if (el.id === 'showNewResp') { state.respPinned = null; renderComments(); }
      else if (el.closest('#wordBtn')) wordConfirm();
      else if (el.id === 'wordBack') openExport('scorecards');
      else if (el.closest('#wordGo')) {
        state.withLeaders = $('wLeaders').checked; state.withPanel = $('wPanel').checked;
        renderScorecards();                                            // the page matches what was exported
        exportWord();
      }
      else if (el.id === 'pickNone') { state.picked = []; renderScorecards(); }
      else if (el.closest('#printBtn')) {
        closeExport();
        var panel = $('tab-scorecards'); panel.classList.add('printing'); window.print(); panel.classList.remove('printing');
      }
    });
    document.querySelector('#app').addEventListener('change', function (e) {
      if (e.target.id === 'combine') { state.combine = e.target.checked; renderRankings(); }
      if (e.target.id === 'withLeaders') { state.withLeaders = e.target.checked; renderScorecards(); }
      if (e.target.id === 'withPanel') { state.withPanel = e.target.checked; renderScorecards(); }
      if (e.target.id === 'lFilter') { LG.filterVal = e.target.value; renderLeaders(); }
      if (e.target.id === 'pFilter') { PG.filterVal = e.target.value; renderPanel(); }
      if (e.target.classList.contains('m-sort-select')) {             // phones: the Sort by dropdown presses that column's button
        var tb = e.target.closest('.panel').querySelectorAll('th button')[+e.target.value];
        if (tb) tb.click();
      }
      if (e.target.id === 'onlyContact') { state.onlyContact = e.target.checked; renderComments(); }
      if (e.target.id === 'onlyWritten') { state.onlyWritten = e.target.checked; state.commentsShown = 100; renderComments(); }
      if (e.target.classList.contains('withOnline')) { state.withOnline = e.target.checked; renderAll(); }
    });

    // Chart tooltips
    var tip = $('tip');
    document.addEventListener('mousemove', function (e) {
      var hit = e.target.closest && e.target.closest('[data-tip]');
      document.querySelectorAll('.bar.hover').forEach(function (b) { b.classList.remove('hover'); });
      if (!hit) { tip.hidden = true; return; }
      var bar = hit.nextElementSibling;
      if (bar && bar.classList.contains('bar')) bar.classList.add('hover');
      tip.innerHTML = hit.getAttribute('data-tip');
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX + 14, innerWidth - 270) + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
    });
    setInterval(updateStatus, 15000);
  }

  init();
})();
