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
  var L_TEXTS = LQ.filter(function (q) { return q.type === 'text'; });
  var L_ISSUES = L_TEXTS[0] ? col(L_TEXTS[0]) : null;          // "Key issues"
  var L_OVERALL = L_RATINGS[0] ? col(L_RATINGS[0]) : null;

  var $ = function (id) { return document.getElementById(id); };
  var ANALYTICS = true;    // last tab: how people use the tool (not front and centre)
  var state = {
    key: null, data: null, lastOk: 0, tab: 'overview',
    sortBy: 'rank', sortDir: 1, minN: 3, scorecard: '', commentsShown: 100,
    lSortBy: 'when', lSortDir: 1, picked: [], withLeaders: true
  };
  var sessions = [], byId = {}, rows = [], leaders = [];


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
  function fetchData() {
    var mine = ++reqSeq, wantTest = $('showTest').checked;
    return fetch(API, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'dashboard', key: state.key, test: wantTest })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (mine !== reqSeq || wantTest !== $('showTest').checked) { d = { ok: true, stale: true }; }
      return d;
    });
  }

  var quickRetry = 0, quickTimer = null;
  function load() {
    $('updated').textContent = 'Updating…';
    clearTimeout(quickTimer);
    return fetchData().then(function (d) {
      if (d.stale) return;                      // a newer request is on its way; ignore this answer
      if (!d.ok) {
        if (d.error === 'wrong password' || d.error === 'locked' || d.error === 'no password') {
          signOut(coded(d.message || 'That password did not work.', d.code));
        } else showAlert(coded('The database answered with an error: ' + (d.message || d.error) + '. Showing the last data received.', 'D102', d.code));
        return;
      }
      state.data = d; state.lastOk = Date.now(); quickRetry = 0;
      showAlert(healthMessage(d.health));
      prepare();
      renderAll();
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
    leaders = (state.data.leaders || []).map(function (r) {
      var id = String(r['Session ID'] || ''), s = byId[id];
      return {
        raw: r, row: r._row, id: id, when: r.Timestamp, name: r[L_NAME] || '',
        handled: String(r['Issue status'] || '').indexOf('Handled') === 0, handledNote: r['Issue note'] || '', handledWhen: String(r['Issue status'] || '').replace('Handled ', ''),
        title: s ? s.title : r.Session || '', speakers: s ? s.speakers : r.Speakers || '',
        room: s ? s.room : r.Room || '', date: s ? s.date : String(r.Date || '').slice(0, 10),
        start: s ? s.start : String(r.Time || '').split(/[–-]/)[0].trim(), track: s ? s.track : r.Track || '', type: s ? s.type : ''
      };
    });
    fillFilters();
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
    setOpts($('fDay'), uniq(sessions.map(function (s) { return s.date; })).map(function (d) { return [d, dayLabel(d)]; }), 'All days');
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
    if (day && x.date !== day) return false;
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
    html += '<h2 class="section">Responses per time block</h2><p class="sub">Each bar is one time slot. Hover for details.</p>' +
      columnChart(order.map(function (k) { return blocks[k]; })) +
      '<button type="button" class="link table-toggle" data-toggle="blockTable">Show as a table</button>' +
      '<div id="blockTable" hidden>' + blockTable(order.map(function (k) { return blocks[k]; })) + '</div>';
    $('tab-overview').innerHTML = html;
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

  // Analytics: how people use the tool (for Shawn)
  function renderAnalytics() {
    if (!ANALYTICS) return;
    var list = fRows(), src = {};
    list.forEach(function (r) { src[r.source] = (src[r.source] || 0) + 1; });
    var ev = state.data.events || {}, u = (state.data.health || {}).usage || {};
    var html = '<h2 class="section">How people got to the form</h2><p class="sub">Per response, with the filters above applied.</p><div class="tiles">' +
      ['QR code', 'NFC tag', 'Session Leader badge', 'Link', 'Home screen'].map(function (k) {
        return tile(k, String(src[k] || 0), pct(src[k] || 0, list.length) + ' of responses');
      }).join('') + '</div>' +
      '<h2 class="section">Clicks and installs</h2><p class="sub">Anonymous counts (not filtered). Installs can only be counted on Android; ' +
      'iPhones show up as "Home screen" responses instead.</p><div class="tiles">' +
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
    var slot = 54, left = 40, h = 220, bottom = 44, w = left + data.length * slot;
    var y = function (v) { return 10 + (h - 10) * (1 - v / top); };
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
          leaders.forEach(function (l) { if (l.id === s.id && num(l.raw[L_OVERALL]) != null) lr.push(num(l.raw[L_OVERALL])); });
        });
        var first = w.runs[0];
        var s = { id: first.id, title: w.title, speakers: w.speakers, date: first.date, start: first.start, track: first.track,
                  room: w.runs.length > 1 ? w.runs.length + ' runs' : first.room, runs: w.runs.length };
        return { s: s, st: statsFor(g), rate: null, leader: lr.length ? Math.max.apply(null, lr) : null, leaderAll: lr };
      });
    }
    return fSessions().map(function (s) {
      var g = groups[s.id] || [], st = statsFor(g);
      var lr = leaders.filter(function (l) { return l.id === s.id; }).map(function (l) { return num(l.raw[L_OVERALL]); })
        .filter(function (v) { return v != null; });
      // each leader's own score (never averaged, so disagreement stays visible); sorting uses the highest
      return { s: s, st: st, rate: s.attendance ? st.n / s.attendance : null, leader: lr.length ? Math.max.apply(null, lr) : null, leaderAll: lr };
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
      '<label>Only sessions with at least <select id="minN">' + [1, 3, 5, 10, 20].map(function (n) {
        return '<option' + (n === state.minN ? ' selected' : '') + '>' + n + '</option>';
      }).join('') + '</select> responses</label>' +
      '<span class="few">' + shown.length + ' of ' + data.length + ' sessions shown. Scores from very few people are not reliable.</span>' +
      '<span class="spacer"></span><button type="button" class="secondary small" id="exportBtn">Download ranking (spreadsheet)</button></div>';
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

  function exportCSV() {
    // Ranked best to worst by overall score; sessions below the minimum responses come last, unranked
    var data = rankingData();
    var ok = rankAll(data);
    var rest = data.filter(function (d) { return ok.indexOf(d) === -1; }).sort(function (a, b) { return b.st.n - a.st.n; });
    ok.forEach(function (d) { d.rankLabel = d.rank + (d.tied ? ' (tied)' : ''); });
    rest.forEach(function (d) { d.rankLabel = d.st.n ? 'fewer than ' + state.minN + ' responses' : 'no responses'; });
    data = ok.concat(rest);
    var head = ['Rank', 'Session ID', 'Session', 'Speakers', state.combine ? 'Room / runs' : 'Room', 'Day', 'Start', 'Track', 'Responses']
      .concat(RATINGS.map(function (q) { return 'Average ' + col(q); }))
      .concat(PRACTICE ? ['% ' + PRACTICE.options[0]] : []).concat(L_OVERALL ? ['Session Leader scores'] : []);
    var lines = [head].concat(data.map(function (d) {
      return [d.rankLabel, d.s.id, d.s.title, d.s.speakers, d.s.room, d.s.date, d.s.start, d.s.track, d.st.n]
        .concat(d.st.avgs.map(function (a) { return a == null ? '' : a.toFixed(2); }))
        .concat(PRACTICE ? [d.st.practiceN ? Math.round(100 * d.st.practiceYes / d.st.practiceN) : ''] : [])
        .concat(L_OVERALL ? [d.leaderAll.join(' / ')] : []);
    }));
    var csv = lines.map(function (l) {
      return l.map(function (v) {
        v = String(v == null ? '' : v);
        if (/^[=+\-@]/.test(v)) v = "'" + v;                     // no spreadsheet formulas
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = 'IFC2026 session ranking' + (state.combine ? ' (workshops combined)' : '') + '.csv';
    a.click();
  }


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
    // Names and emails show only here (people who ticked "open to being contacted"), never in scorecards or exports
    var all = rows.filter(function (r) {
      return (state.withOnline || !r.online) && (commentText(r).trim() || r.contact) && matches(r, commentText(r) + ' ' + r.contactName + ' ' + r.contactEmail);
    }).sort(function (a, b) { return String(b.when).localeCompare(String(a.when)); });
    var nContact = all.filter(function (r) { return r.contact; }).length;
    var list = state.onlyContact ? all.filter(function (r) { return r.contact; }) : all;
    var shown = list.slice(0, state.commentsShown);
    var html = '<div class="controls"><span>' + all.length + ' responses with a written comment or contact details, newest first.</span>' +
      '<label class="toggle"><input type="checkbox" id="onlyContact"' + (state.onlyContact ? ' checked' : '') + '> Only people open to being contacted (' + nContact + ')</label></div>' +
      '<div class="comments">' +
      shown.map(commentCard).join('') + '</div>';
    if (list.length > shown.length) html += '<p><button type="button" class="secondary small" id="moreComments">Show more</button></p>';
    if (!list.length) html = '<p class="empty">No written comments match these filters yet.</p>';
    $('tab-comments').innerHTML = html;
  }

  function commentCard(r) {
        return '<article class="comment"><div class="meta"><button type="button" class="linkish who" data-card="' + esc(r.id) + '">' + esc(r.title) + '</button> · ' +
          (r.online ? '<strong>Online</strong>' : esc(r.room)) + ' · ' + esc(dayLabel(r.date)) + ' ' + esc(r.start) +
          (num(r.raw[OVERALL]) ? ' · <span class="stars-txt" aria-label="' + num(r.raw[OVERALL]) + ' out of 5">' + starsText(num(r.raw[OVERALL])) + '</span>' : '') +
          ' · ' + esc(localTime(r.when)) + '</div>' +
          answersLine(r) +
          TEXTS.map(function (q) {
            var v = r.raw[col(q)];
            return v ? '<p><span class="k">' + esc(col(q)) + ':</span> ' + esc(v) + '</p>' : '';
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

  function leaderBlock(s) {
    var ls = leaders.filter(function (l) { return l.id === s.id; });
    if (!ls.length) return '';
    return '<div class="leader-box"><div class="qname">Session Leader report' + (ls.length > 1 ? 's (' + ls.length + ')' : '') + '</div>' +
      ls.map(function (l) {
        return '<div class="leader-one"><strong>' + esc(l.name || 'Session Leader') + '</strong> · ' +
          L_RATINGS.map(function (q) { return esc(q.label) + ' <strong>' + (num(l.raw[col(q)]) || '–') + '</strong>/5'; }).join(' · ') +
          L_TEXTS.map(function (q) {
            var v = l.raw[col(q)];
            return v ? '<p class="' + (col(q) === L_ISSUES ? 'issue' : '') + '"><span class="k">' + esc(q.label) + ':</span> ' + esc(v) + '</p>' : '';
          }).join('') + '</div>';
      }).join('') + '</div>';
  }

  // Session leaders tab: every report, key issues first
  function renderLeaders() {
    var list = leaders.filter(function (l) {
      return matches(l, l.name + ' ' + L_TEXTS.map(function (q) { return l.raw[col(q)] || ''; }).join(' '));
    }).sort(function (a, b) { return (a.date + a.start + a.room).localeCompare(b.date + b.start + b.room); });
    var hasIssue = function (l) { return L_ISSUES && String(l.raw[L_ISSUES] || '').trim(); };
    var issues = list.filter(function (l) { return hasIssue(l) && !l.handled; });
    var handledN = list.filter(function (l) { return hasIssue(l) && l.handled; }).length;
    $('issueCount').textContent = leaders.filter(function (l) { return hasIssue(l) && !l.handled; }).length || '';
    var covered = {}; list.forEach(function (l) { covered[l.id] = 1; });
    // sort by the chosen column (click a heading); ties keep day/time order
    var lval = function (l) {
      var k = state.lSortBy;
      if (k === 'when') return l.date + l.start + l.room;
      if (k === 'title') return l.title.toLowerCase();
      if (k === 'name') return String(l.name).toLowerCase();
      if (k === 'issue') return L_ISSUES && String(l.raw[L_ISSUES] || '').trim() ? 1 : 0;
      var v = num(l.raw[k]); return v == null ? -1 : v;
    };
    var lsort = function (a, b) { var x = lval(a), y = lval(b); return (x > y ? 1 : x < y ? -1 : 0) * state.lSortDir || (a.date + a.start).localeCompare(b.date + b.start); };
    list.sort(lsort); issues.sort(lsort);
    var html = '<div class="tiles">' +
      tile('Session Leader reports', String(list.length), Object.keys(covered).length + ' of ' + fSessions().length + ' sessions covered') +
      L_RATINGS.map(function (q) {
        var vals = list.map(function (l) { return num(l.raw[col(q)]); }).filter(function (v) { return v != null; });
        return tile('Average ' + q.label.toLowerCase(), vals.length ? fmt1(mean(vals)) + ' <small>/ 5</small>' : '–', vals.length + ' ratings');
      }).join('') +
      tile('Open key issues', String(issues.length), (issues.length ? 'Listed first below' : 'Nothing waiting') + (handledN ? ' · ' + handledN + ' handled' : '')) + '</div>';
    var row = function (l) {
      return '<tr' + (issues.indexOf(l) > -1 ? ' class="has-issue"' : '') + '><td><button type="button" class="linkish" data-card="' + esc(l.id) + '">' + esc(l.title) + '</button></td>' +
        '<td>' + esc(dayLabel(l.date) + ', ' + l.start) + '<div class="t-sub">' + esc(l.room) + '</div></td>' +
        '<td>' + esc(l.name) + '</td>' +
        L_RATINGS.map(function (q) { return '<td class="num">' + (num(l.raw[col(q)]) || '–') + '</td>'; }).join('') +
        '<td>' + L_TEXTS.map(function (q) {
          var v = l.raw[col(q)];
          var cls = col(q) === L_ISSUES ? (l.handled ? 'issue handled' : 'issue') : '';
          return v ? '<p class="' + cls + '"><span class="k">' + esc(q.label) + ':</span> ' + esc(v) + '</p>' : '';
        }).join('') +
        (hasIssue(l) && !l.handled ? '<button type="button" class="secondary small" data-resolve="' + l.row + '" data-ts="' + esc(l.when) + '">Mark as handled</button>' : '') +
        (l.handled ? '<p class="handled-note">Handled ' + esc(l.handledWhen) + (l.handledNote ? ': ' + esc(l.handledNote) : '') +
          ' <button type="button" class="link" data-reopen="' + l.row + '" data-ts="' + esc(l.when) + '">Reopen</button></p>' : '') +
        '</td></tr>';
    };
    var lth = function (k, label, numCol) {
      var sorted = state.lSortBy === k ? ' aria-sort="' + (state.lSortDir > 0 ? 'ascending' : 'descending') + '"' : '';
      return '<th class="' + (numCol ? 'num' : '') + '"><button type="button" data-lsort="' + esc(k) + '"' + sorted + '>' + esc(label) + '</button></th>';
    };
    var head = '<thead><tr>' + lth('title', 'Session') + lth('when', 'When') + lth('name', 'Session Leader') +
      L_RATINGS.map(function (q) { return lth(col(q), q.label, 1); }).join('') + lth('issue', 'Comments') + '</tr></thead>';
    if (issues.length) html += '<h2 class="section">Key issues to look at</h2><div class="tbl-wrap"><table class="tbl">' + head + '<tbody>' + issues.map(row).join('') + '</tbody></table></div>';
    html += '<h2 class="section">All leader reports</h2>' + (list.length
      ? '<div class="tbl-wrap"><table class="tbl">' + head + '<tbody>' + list.map(row).join('') + '</tbody></table></div>'
      : '<p class="empty">No Session Leader reports yet. The form is at <strong>/sessionleader</strong>.</p>');
    $('tab-leaders').innerHTML = html;
  }

  /* ---------- per-speaker ratings ("Jane Doe: 4; John Roe: 5") ---------- */

  function speakerScores(list) {
    var by = {}, order = [];
    if (!SPEAKERQ || !SPEAKERQ.detailColumn) return [];
    list.forEach(function (r) {
      String(r.raw[SPEAKERQ.detailColumn] || '').split(/\s*;\s*/).forEach(function (part) {
        var m = part.match(/^(.*\S)\s*:\s*([1-5](?:\.\d)?)$/);
        if (!m) return;
        if (!by[m[1]]) { by[m[1]] = []; order.push(m[1]); }
        by[m[1]].push(+m[2]);
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
  function workshopCard(w, byRun, withLeaders) {
    var all = [];
    w.runs.forEach(function (s) { all = all.concat(byRun[s.id] || []); });
    var st = statsFor(all), multi = w.runs.length > 1;
    var html = '<article class="card" data-workshop="' + esc(w.key) + '"><h3>' + esc(w.title) + '</h3><div class="meta">' +
      esc(w.speakers || '') + (w.speakers ? ' · ' : '') + (multi ? 'Ran ' + w.runs.length + ' times · ' : esc(runLabel(w.runs[0])) + ' · ') +
      '<strong>' + st.n + ' response' + (st.n === 1 ? '' : 's') + '</strong></div>';
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
    if (withLeaders) html += w.runs.map(function (s) {
      var b = leaderBlock(s);
      return b && multi ? b.replace('Session Leader report', 'Run ' + (w.runs.indexOf(s) + 1) + ': Session Leader report') : b;
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
        var vals = (byRun[s.id] || []).map(function (r) { return String(r.raw[col(q)] || '').trim(); }).filter(Boolean);
        total += vals.length;
        if (!vals.length) return '';
        return (multi ? '<div class="runhead">Run ' + (i + 1) + ': ' + esc(runLabel(s)) + '</div>' : '') +
          '<ul>' + vals.map(function (v) { return '<li>' + esc(v) + '</li>'; }).join('') + '</ul>';
      }).join('');
      return '<div class="qname">' + esc(q.label) + ' <span class="few">(' + total + ')</span></div>' + (total ? parts : '<p class="few">None.</p>');
    }).join('');
    return html + '</article>';
  }

  function scorecardData() {
    var list = fRows(), byRun = {};
    list.forEach(function (r) { if (!r.typed) (byRun[r.id] = byRun[r.id] || []).push(r); });
    var withLeader = {}; leaders.forEach(function (l) { withLeader[l.id] = 1; });
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
      onlineToggle() +
      '<button type="button" class="secondary small" id="wordBtn">Download for editing (Word)</button>' +
      '<button type="button" class="secondary small" id="printBtn">Print or save as PDF</button></div>';
    html += show.length ? show.map(function (w) { return workshopCard(w, sd.byRun, state.withLeaders); }).join('')
      : '<p class="empty">No sessions with feedback match these filters.</p>';
    $('tab-scorecards').innerHTML = html;
  }


  /* ---------- Word export (editable before sending to speakers) ---------- */

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
    var oneDoc = !many || confirm(ws.length + ' sessions/workshops.\n\nOK = one Word document with each on its own page\nCancel = a separate Word file for each (in a zip)');
    var btn = $('wordBtn'); btn.disabled = true; btn.textContent = 'Preparing…';
    var libs = loadScript('https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js')
      .then(function () { return many && !oneDoc ? loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js') : null; });
    libs.then(function () {
      var D = window.docx;
      var fname = function (w) { return 'IFC2026 feedback - ' + w.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80) + '.docx'; };
      var build = function (list) {
        var children = [];
        list.forEach(function (w, i) { children = children.concat(docxWorkshop(D, w, sd.byRun, state.withLeaders, i > 0)); });
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
    }).then(function () { btn.disabled = false; btn.textContent = 'Download for editing (Word)'; });
  }

  function save(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  // Plain, tidy Word content: headings, a comparison table, score summaries, comments as bullet points
  function docxWorkshop(D, w, byRun, withLeaders, newPage) {
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
        var vals = (byRun[s.id] || []).map(function (r) { return String(r.raw[col(q)] || '').trim(); }).filter(Boolean);
        if (!vals.length) return;
        any = true;
        if (multi) out.push(P('Run ' + (i + 1) + ': ' + runLabel(s), { run: { bold: true, size: 19 } }));
        vals.forEach(function (v) { out.push(new D.Paragraph({ text: v, bullet: { level: 0 } })); });
      });
      if (!any) out.push(P('None.', { run: { italics: true } }));
    });
    if (withLeaders) {
      var ls = leaders.filter(function (l) { return w.runs.some(function (s) { return s.id === l.id; }); });
      if (ls.length) {
        out.push(P('Session Leader reports (internal)', { para: { heading: D.HeadingLevel.HEADING_2 } }));
        ls.forEach(function (l) {
          var s = byId[l.id];
          out.push(P((l.name || 'Session Leader') + (s ? ' · ' + runLabel(s) : ''), { run: { bold: true } }));
          out.push(P(L_RATINGS.map(function (q) { return q.label + ': ' + (num(l.raw[col(q)]) || '–') + '/5'; }).join(' · ')));
          L_TEXTS.forEach(function (q) { if (l.raw[col(q)]) out.push(P(q.label + ': ' + l.raw[col(q)])); });
        });
      }
    }
    out.push(P(''));
    out.push(P('Feedback was given anonymously by IFC 2026 attendees.', { run: { italics: true, color: '545454', size: 18 } }));
    return out;
  }


  /* ---------- typed in ("My session isn't listed") ---------- */

  function renderTyped() {
    var all = rows.filter(function (r) { return r.typed; })
      .sort(function (a, b) { return String(b.when).localeCompare(String(a.when)); });
    var dismissed = all.filter(function (r) { return /no match/i.test(r.raw.Note || ''); });
    var list = all.filter(function (r) { return dismissed.indexOf(r) === -1; });
    $('typedCount').textContent = list.length || '';
    var html = '<p class="sub">Answers from people who could not find their session and typed it in. ' +
      'Use these to spot a missing or misnamed session in the Sessions tab.</p>';
    var matched = rows.filter(function (r) { return /matched on dashboard/.test(r.raw.Note || ''); }).length;
    if (matched) html += '<p class="sub">' + matched + ' already matched to a session (they now count in that session\'s results).</p>';
    html += list.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>What they typed</th><th class="num">Overall</th>' +
      '<th>Match to session</th></tr></thead><tbody>' +
      list.map(function (r) {
        var guess = bestGuess(r.title);
        return '<tr><td>' + esc(localTime(r.when)) + '</td><td class="t-title">' + esc(r.title) +
          TEXTS.map(function (q) { return r.raw[col(q)] ? '<div class="t-sub">' + esc(col(q)) + ': ' + esc(r.raw[col(q)]) + '</div>' : ''; }).join('') +
          '</td><td class="num">' + (num(r.raw[OVERALL]) || '–') + '</td>' +
          '<td class="assign"><select data-row="' + r.row + '" aria-label="Session for this response">' + sessionOptions(guess) + '</select> ' +
          '<button type="button" class="secondary small" data-assign="' + r.row + '" data-ts="' + esc(r.when) + '">Match</button>' +
          '<button type="button" class="link" data-nomatch="' + r.row + '" data-ts="' + esc(r.when) + '">No match</button>' +
          (guess ? '<div class="t-sub">Best guess pre-selected. Check it before matching.</div>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      : '<p class="empty">Nothing waiting to be matched.' + (matched ? '' : ' Good sign: the list is complete.') + '</p>';
    if (dismissed.length) {
      html += '<details class="dismissed"><summary>' + dismissed.length + ' marked "no match" (still kept in the database)</summary>' +
        '<div class="tbl-wrap"><table class="tbl"><tbody>' + dismissed.map(function (r) {
          return '<tr><td>' + esc(localTime(r.when)) + '</td><td class="t-title">' + esc(r.title) + '</td><td class="num">' + (num(r.raw[OVERALL]) || '–') + '</td>' +
            '<td><button type="button" class="link" data-restore="' + r.row + '" data-ts="' + esc(r.when) + '">Restore</button></td></tr>';
        }).join('') + '</tbody></table></div></details>';
    }
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

  // Session Leader key issue: mark handled (with a note) or reopen. The row goes at once;
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
    var cnt = $('issueCount'); var before = cnt.textContent;
    if (!reopen) cnt.textContent = Math.max(0, (+before || 0) - 1) || '';
    btn.disabled = true;
    fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'resolve', key: state.key, test: $('showTest').checked, row: +(btn.dataset.resolve || btn.dataset.reopen),
        timestamp: btn.dataset.ts, note: note, reopen: !!reopen })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { var err = new Error(j.error || 'not saved'); err.code = j.code; err.answered = true; throw err; }
      load();
    }).catch(function (e) {
      if (tr) tr.hidden = false; cnt.textContent = before; btn.disabled = false;
      alert(e.answered ? coded('Not saved: ' + e.message + '. Please try again.', 'D201', e.code)
                       : coded('Could not reach the database. Please try again.', 'D202'));
    });
  }

  function assign(btn, special) {
    var row = btn.dataset.assign || btn.dataset.nomatch || btn.dataset.restore, sessionId = special;
    if (!special) {
      var sel = document.querySelector('select[data-row="' + row + '"]');
      if (!sel.value) { sel.focus(); return; }
      var s = byId[sel.value];
      if (!confirm('Match this response to "' + s.title + '" (' + s.room + ', ' + dayLabel(s.date) + ' ' + s.start + ')?\n\nThis updates the database.')) return;
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
      body: JSON.stringify({ action: 'assign', key: state.key, test: $('showTest').checked, row: +row, timestamp: btn.dataset.ts, sessionId: sessionId })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { if (tr) tr.hidden = false; cnt.textContent = before; alert(coded('Not saved: ' + (j.error || 'unknown problem') + '.', 'D201', j.code)); btn.disabled = false; btn.textContent = label; return; }
      load();
    }).catch(function () { if (tr) tr.hidden = false; cnt.textContent = before; alert(coded('Could not reach the database. Please try again.', 'D202')); btn.disabled = false; btn.textContent = label; });
  }


  /* ---------- page wiring ---------- */

  function renderAll() {
    renderOverview(); renderRankings(); renderComments(); renderLeaders(); renderOnline(); renderScorecards(); renderTyped(); renderAnalytics();
  }

  function updateStatus() {
    var fresh = state.lastOk && Date.now() - state.lastOk < 3 * REFRESH_MS;
    $('liveDot').classList.toggle('stale', !fresh);
    $('updated').textContent = state.lastOk
      ? (fresh ? 'Live · ' : 'Not updating · ') + 'updated ' + ago(Date.now() - state.lastOk) +
        ($('showTest').checked ? ' · showing TEST responses' : '')
      : 'Loading…';

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
    var on = document.querySelector('.tabs [aria-selected=true]');       // phones: tabs scroll sideways, keep the chosen one in view
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // Phones show each table row as a card, so every cell needs its column name
  function labelTables(root) {
    root.querySelectorAll('table.tbl').forEach(function (t) {
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

  function signOut(msg) {
    state.key = null;
    store('local', KEY_STORE, null); store('session', KEY_STORE, null);
    $('app').hidden = true; $('login').hidden = false;
    $('loginError').textContent = msg || '';
    $('pw').value = ''; $('pw').focus();
  }

  var timer = null;
  function start() {
    $('login').hidden = true; $('app').hidden = false;
    load();
    clearInterval(timer);
    timer = setInterval(function () { if (document.visibilityState === 'visible') load(); else updateStatus(); }, REFRESH_MS);
  }

  function init() {
    if (!API) { $('login').hidden = false; $('loginError').textContent = coded('No database address in config.js yet.', 'D104'); return; }
    // A sign-in link carries the password after #, which never leaves the browser.
    // It is remembered on this device and then tidied out of the address bar.
    if (location.hash.length > 1) {
      try { state.key = decodeURIComponent(location.hash.slice(1)); } catch (e) { state.key = location.hash.slice(1); }
      store('local', KEY_STORE, state.key);
      history.replaceState(null, '', location.pathname + location.search);
    }
    // ?test in the link opens with test responses showing (for demos to the team)
    // DEMO PERIOD: test responses show by default so the dashboard looks lived-in when shown
    // to people. Untick "Show test responses" for real feedback, or open the link with ?real.
    // Set SHOW_TEST_BY_DEFAULT to false (or remove test mode) before the conference.
    var SHOW_TEST_BY_DEFAULT = true;
    $('showTest').checked = /[?&]test(=|&|$)/.test(location.search) || (SHOW_TEST_BY_DEFAULT && !/[?&]real(=|&|$)/.test(location.search));
    $('testBanner').hidden = !$('showTest').checked;
    state.key = state.key || store('session', KEY_STORE) || store('local', KEY_STORE);
    if (state.key) start(); else $('login').hidden = false;

    $('login').addEventListener('submit', function (e) {
      e.preventDefault();
      var key = $('pw').value;
      $('loginBtn').disabled = true; $('loginError').textContent = '';
      state.key = key;
      fetchData().then(function (d) {
        $('loginBtn').disabled = false;
        if (d.stale) { $('loginBtn').disabled = false; return; }
        if (!d.ok) { $('loginError').textContent = coded(d.message || 'That password did not work.', d.code); return; }
        store($('remember').checked ? 'local' : 'session', KEY_STORE, key);
        state.data = d; state.lastOk = Date.now();
        $('login').hidden = true; $('app').hidden = false;
        prepare(); renderAll(); updateStatus();
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
      state.data = null; state.lastOk = 0;
      $('testBanner').hidden = !$('showTest').checked;
      ['overview', 'rankings', 'comments', 'leaders', 'online', 'scorecards', 'typed', 'analytics'].forEach(function (t) {
        $('tab-' + t).innerHTML = '<p class="empty">Loading ' + ($('showTest').checked ? 'test' : 'real') + ' responses…</p>';
      });
      load();
    });
    ['fDay', 'fType', 'fTrack', 'fRoom'].forEach(function (id) { $(id).addEventListener('change', renderAll); });
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
        var k = el.dataset.lsort;
        state.lSortDir = state.lSortBy === k ? -state.lSortDir : (k === 'when' || k === 'title' || k === 'name' ? 1 : -1);
        state.lSortBy = k; renderLeaders();
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
      else if (el.id === 'exportBtn') exportCSV();
      else if (el.id === 'moreComments') { state.commentsShown += 100; renderComments(); }
      else if (el.id === 'wordBtn') exportWord();
      else if (el.id === 'pickNone') { state.picked = []; renderScorecards(); }
      else if (el.id === 'printBtn') {
        var panel = $('tab-scorecards'); panel.classList.add('printing'); window.print(); panel.classList.remove('printing');
      }
    });
    document.querySelector('#app').addEventListener('change', function (e) {
      if (e.target.id === 'minN') { state.minN = +e.target.value; renderRankings(); }
      if (e.target.id === 'combine') { state.combine = e.target.checked; renderRankings(); }
      if (e.target.id === 'withLeaders') { state.withLeaders = e.target.checked; renderScorecards(); }
      if (e.target.id === 'onlyContact') { state.onlyContact = e.target.checked; renderComments(); }
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
