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
  var RATINGS = Q.filter(function (q) { return q.type === 'rating'; });
  var CHOICES = Q.filter(function (q) { return q.type === 'choice'; });
  var TEXTS = Q.filter(function (q) { return q.type === 'text'; });
  var col = function (q) { return q.column || q.label; };
  var OVERALL = RATINGS[0] ? col(RATINGS[0]) : null;
  var PRACTICE = CHOICES[0] || null;          // "Will you put something into practice?"

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    key: null, data: null, lastOk: 0, tab: 'overview',
    sortBy: 'avg0', sortDir: -1, minN: 3, scorecard: '', commentsShown: 100
  };
  var sessions = [], byId = {}, rows = [];


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

  function fetchData() {
    return fetch(API, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'dashboard', key: state.key, test: $('showTest').checked })
    }).then(function (r) { return r.json(); });
  }

  function load() {
    $('updated').textContent = 'Updating…';
    return fetchData().then(function (d) {
      if (!d.ok) {
        if (d.error === 'wrong password' || d.error === 'locked' || d.error === 'no password') {
          signOut(d.message || 'That password did not work.');
        } else showAlert('The Sheet answered with an error: ' + (d.message || d.error) + '. Showing the last data received.');
        return;
      }
      state.data = d; state.lastOk = Date.now();
      showAlert(healthMessage(d.health));
      prepare();
      renderAll();
    }).catch(function () {
      showAlert('Could not reach the Google Sheet just now. Will try again in a minute. Showing the last data received.');
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

    rows = (state.data.responses || []).map(function (r) {
      var id = String(r['Session ID'] || '');
      var s = byId[id];
      var t = String(r.Time || '').split(/[–-]/);
      return {
        raw: r, row: r._row, id: id, typed: id === 'NOT LISTED', when: r.Timestamp,
        title: s ? s.title : r.Session || '', speakers: s ? s.speakers : r.Speakers || '',
        room: s ? s.room : r.Room || '', date: s ? s.date : String(r.Date || '').slice(0, 10),
        start: s ? s.start : (t[0] || '').trim(), track: s ? s.track : r.Track || '', type: s ? s.type : '',
        source: r['Came from'] || 'Unknown'
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
    setOpts($('fTrack'), uniq(sessions.map(function (s) { return s.track; }).concat(sessions.map(function (s) { return s.type; })))
      .map(function (v) { return [v, v]; }), 'All');
    setOpts($('fRoom'), uniq(sessions.map(function (s) { return s.room.split(' (')[0]; }))
      .sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); }).map(function (v) { return [v, v]; }), 'All rooms');
  }


  /* ---------- filtering ---------- */

  function matches(x, withText) {
    var day = $('fDay').value, tr = $('fTrack').value, room = $('fRoom').value;
    var text = $('fText').value.trim().toLowerCase();
    if (day && x.date !== day) return false;
    if (tr && x.track !== tr && x.type !== tr) return false;
    if (room && x.room.split(' (')[0] !== room) return false;
    if (text && withText !== false) {
      var hay = (x.title + ' ' + x.speakers + ' ' + x.room + ' ' + (withText || '')).toLowerCase();
      if (hay.indexOf(text) === -1) return false;
    }
    return true;
  }
  function commentText(r) { return TEXTS.map(function (q) { return r.raw[col(q)] || ''; }).join(' '); }
  function fRows() { return rows.filter(function (r) { return matches(r, commentText(r)); }); }
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
    var src = {}; list.forEach(function (r) { src[r.source] = (src[r.source] || 0) + 1; });
    var srcTxt = ['QR code', 'Link', 'Home screen'].filter(function (k) { return src[k]; })
      .map(function (k) { return k + ' ' + pct(src[k], list.length); }).join(' · ') || '–';
    var last = list.reduce(function (m, r) { var t = Date.parse(r.when); return t > m ? t : m; }, 0);

    var html = '<div class="tiles">' +
      tile('Responses', list.length.toLocaleString(), last ? 'Last one ' + ago(Date.now() - last) : 'None yet') +
      tile('Sessions with feedback', ratedN + ' <small>of ' + ses.length + '</small>', pct(ratedN, ses.length) + ' of sessions') +
      tile('Average overall', st.avgs[0] == null ? '–' : fmt1(st.avgs[0]) + ' <small>/ 5</small>', 'From ' + list.filter(function (r) { return num(r.raw[OVERALL]) != null; }).length + ' ratings') +
      (PRACTICE ? tile('Will put into practice', pct(st.practiceYes, st.practiceN), '“' + esc(PRACTICE.options[0]) + '”, of ' + st.practiceN + ' who answered') : '') +
      tile('How people got here', '', srcTxt) +
      '</div>';
    var ev = state.data.events || {};
    html += '<h2 class="section">Clicks and installs</h2><p class="sub">Anonymous counts. Installs can only be counted on Android; ' +
      'iPhones show up as "Home screen" opens instead.</p><div class="tiles">' +
      tile('“Contact us” clicks', String(ev.help || 0), 'People who tapped the help link') +
      tile('ShawnLife clicks', String(ev.shawnlife || 0), 'Footer credit link') +
      tile('Saw the home-screen tip', String(ev['tip-shown'] || 0), 'Shown on the thank-you screen') +
      tile('Added to home screen', String(ev.installed || 0), 'Android installs') +
      tile('Opened from home screen', String(src['Home screen'] || 0), 'Responses sent from the home-screen icon') +
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
    return fSessions().map(function (s) {
      var g = groups[s.id] || [], st = statsFor(g);
      return { s: s, st: st, rate: s.attendance ? st.n / s.attendance : null };
    });
  }

  function renderRankings() {
    var data = rankingData();
    var hasRate = data.some(function (d) { return d.rate != null; });
    var shown = data.filter(function (d) { return d.st.n >= state.minN; });
    var key = state.sortBy, dir = state.sortDir;
    var val = function (d) {
      if (key === 'n') return d.st.n;
      if (key === 'rate') return d.rate == null ? -1 : d.rate;
      if (key === 'practice') return d.st.practiceN ? d.st.practiceYes / d.st.practiceN : -1;
      if (key === 'when') return d.s.date + d.s.start + d.s.room;
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
      '<label>Only sessions with at least <select id="minN">' + [1, 3, 5, 10, 20].map(function (n) {
        return '<option' + (n === state.minN ? ' selected' : '') + '>' + n + '</option>';
      }).join('') + '</select> responses</label>' +
      '<span class="few">' + shown.length + ' of ' + data.length + ' sessions shown. Scores from very few people are not reliable.</span>' +
      '<span class="spacer"></span><button type="button" class="secondary small" id="exportBtn">Download as spreadsheet (CSV)</button></div>';
    html += '<div class="tbl-wrap"><table class="tbl"><thead><tr>' + th('title', 'Session') + th('when', 'When / room') + th('n', 'Responses', 1) +
      (hasRate ? th('rate', 'Response rate', 1) : '') +
      RATINGS.map(function (q, i) { return th('avg' + i, esc(col(q).replace(' (1-5)', '')), 1); }).join('') +
      (PRACTICE ? th('practice', 'Will apply', 1) : '') + '</tr></thead><tbody>';
    html += shown.map(function (d) {
      return '<tr><td><button type="button" class="linkish" data-card="' + esc(d.s.id) + '">' + esc(d.s.title) + '</button>' +
        (d.s.speakers ? '<div class="t-sub">' + esc(d.s.speakers) + '</div>' : '') + '</td>' +
        '<td>' + esc(dayLabel(d.s.date)) + ', ' + esc(d.s.start) + '<div class="t-sub">' + esc(d.s.room) + '</div></td>' +
        '<td class="num">' + d.st.n + '</td>' +
        (hasRate ? '<td class="num">' + (d.rate == null ? '–' : Math.round(d.rate * 100) + '%') + '</td>' : '') +
        d.st.avgs.map(function (a, i) {
          return '<td class="num">' + fmt1(a) + (i === 0 && a != null ? '<span class="scorebar" aria-hidden="true"><i style="width:' + (a / 5 * 100) + '%"></i></span>' : '') + '</td>';
        }).join('') +
        (PRACTICE ? '<td class="num">' + pct(d.st.practiceYes, d.st.practiceN) + '</td>' : '') + '</tr>';
    }).join('') + '</tbody></table></div>';
    if (!shown.length) html += '<p class="empty">No sessions have that many responses yet. Lower the minimum above.</p>';
    $('tab-rankings').innerHTML = html;
  }

  function exportCSV() {
    var data = rankingData();
    var head = ['Session ID', 'Session', 'Speakers', 'Room', 'Day', 'Start', 'Track', 'Responses']
      .concat(RATINGS.map(function (q) { return 'Average ' + col(q); }))
      .concat(PRACTICE ? ['% ' + PRACTICE.options[0]] : []);
    var lines = [head].concat(data.map(function (d) {
      return [d.s.id, d.s.title, d.s.speakers, d.s.room, d.s.date, d.s.start, d.s.track, d.st.n]
        .concat(d.st.avgs.map(function (a) { return a == null ? '' : a.toFixed(2); }))
        .concat(PRACTICE ? [d.st.practiceN ? Math.round(100 * d.st.practiceYes / d.st.practiceN) : ''] : []);
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
    a.download = 'IFC2026-session-results.csv';
    a.click();
  }


  /* ---------- comments ---------- */

  function renderComments() {
    var list = fRows().filter(function (r) { return commentText(r).trim(); })
      .sort(function (a, b) { return String(b.when).localeCompare(String(a.when)); });
    var shown = list.slice(0, state.commentsShown);
    var html = '<p class="sub">' + list.length + ' responses with written comments, newest first.</p><div class="comments">' +
      shown.map(function (r) {
        return '<article class="comment"><div class="meta"><button type="button" class="linkish who" data-card="' + esc(r.id) + '">' + esc(r.title) + '</button> · ' +
          esc(r.room) + ' · ' + esc(dayLabel(r.date)) + ' ' + esc(r.start) +
          (num(r.raw[OVERALL]) ? ' · <span class="stars-txt" aria-label="' + num(r.raw[OVERALL]) + ' out of 5">' + starsText(num(r.raw[OVERALL])) + '</span>' : '') +
          ' · ' + esc(localTime(r.when)) + '</div>' +
          TEXTS.map(function (q) {
            var v = r.raw[col(q)];
            return v ? '<p><span class="k">' + esc(col(q)) + ':</span> ' + esc(v) + '</p>' : '';
          }).join('') + '</article>';
      }).join('') + '</div>';
    if (list.length > shown.length) html += '<p><button type="button" class="secondary small" id="moreComments">Show more</button></p>';
    if (!list.length) html = '<p class="empty">No written comments match these filters yet.</p>';
    $('tab-comments').innerHTML = html;
  }


  /* ---------- scorecards ---------- */

  function scorecard(s, list) {
    var st = statsFor(list);
    var html = '<article class="card"><h3>' + esc(s.title) + '</h3><div class="meta">' +
      esc([s.speakers, s.room, dayLabel(s.date) + (s.start ? ', ' + s.start + (s.end ? '–' + s.end : '') : '')].filter(Boolean).join(' · ')) +
      ' · <strong>' + st.n + ' responses</strong>' + (s.attendance ? ' (' + Math.round(100 * st.n / s.attendance) + '% of ' + s.attendance + ' attendees)' : '') + '</div>';
    if (!list.length) return html + '<p class="empty">No feedback yet.</p></article>';
    html += '<div class="row">' + RATINGS.map(function (q, i) {
      var vals = list.map(function (r) { return num(r.raw[col(q)]); }).filter(function (v) { return v != null; });
      var counts = [5, 4, 3, 2, 1].map(function (n) { return vals.filter(function (v) { return v === n; }).length; });
      var mx = Math.max.apply(null, counts.concat(1));
      return '<div><div class="qname">' + esc(q.label) + '</div><div class="avg">' + fmt1(st.avgs[i]) + ' <small>/ 5 · ' + vals.length + ' ratings</small></div>' +
        '<div class="dist">' + counts.map(function (c, k) {
          return '<span>' + (5 - k) + '★</span><span class="b"><i style="width:' + (c / mx * 100) + '%"></i></span><span class="n">' + c + '</span>';
        }).join('') + '</div></div>';
    }).join('') + CHOICES.map(function (q) {
      var vals = list.map(function (r) { return r.raw[col(q)]; }).filter(Boolean);
      var mx = Math.max.apply(null, q.options.map(function (o) { return vals.filter(function (v) { return v === o; }).length; }).concat(1));
      return '<div><div class="qname">' + esc(q.label) + '</div><div class="dist" style="grid-template-columns: 110px 1fr 40px">' +
        q.options.map(function (o) {
          var c = vals.filter(function (v) { return v === o; }).length;
          return '<span>' + esc(o) + '</span><span class="b"><i style="width:' + (c / mx * 100) + '%"></i></span><span class="n">' + c + '</span>';
        }).join('') + '</div></div>';
    }).join('') + '</div>';
    html += TEXTS.map(function (q) {
      var vals = list.map(function (r) { return String(r.raw[col(q)] || '').trim(); }).filter(Boolean);
      return '<div class="qname">' + esc(q.label) + ' <span class="few">(' + vals.length + ')</span></div>' +
        (vals.length ? '<ul>' + vals.map(function (v) { return '<li>' + esc(v) + '</li>'; }).join('') + '</ul>' : '<p class="few">None.</p>');
    }).join('');
    return html + '</article>';
  }

  function renderScorecards() {
    var list = fRows(), groups = {};
    list.forEach(function (r) { if (!r.typed) (groups[r.id] = groups[r.id] || []).push(r); });
    var ses = fSessions().filter(function (s) { return groups[s.id]; })
      .sort(function (a, b) { return (a.date + a.start + a.room).localeCompare(b.date + b.start + b.room); });
    if (state.scorecard && !ses.some(function (s) { return s.id === state.scorecard; }) && byId[state.scorecard]) ses.unshift(byId[state.scorecard]);
    var html = '<div class="controls"><label>Session <select id="cardPick"><option value="">All sessions shown (' + ses.length + ')</option>' +
      ses.map(function (s) {
        return '<option value="' + esc(s.id) + '"' + (s.id === state.scorecard ? ' selected' : '') + '>' +
          esc(dayLabel(s.date) + ' ' + s.start + ' · ' + s.title + ' (' + s.room + ')') + '</option>';
      }).join('') + '</select></label>' +
      '<button type="button" class="secondary small" id="printBtn">Print or save as PDF</button>' +
      '<span class="few">Tip: use the filters above (e.g. one day or one track), then print all shown.</span></div>';
    var pick = state.scorecard ? ses.filter(function (s) { return s.id === state.scorecard; }) : ses;
    html += pick.length ? pick.map(function (s) { return scorecard(s, groups[s.id] || []); }).join('')
      : '<p class="empty">No sessions with feedback match these filters.</p>';
    $('tab-scorecards').innerHTML = html;
  }


  /* ---------- typed in ("My session isn't listed") ---------- */

  function renderTyped() {
    var list = rows.filter(function (r) { return r.typed; })
      .sort(function (a, b) { return String(b.when).localeCompare(String(a.when)); });
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
          (guess ? '<div class="t-sub">Best guess pre-selected. Check it before matching.</div>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      : '<p class="empty">Nothing waiting to be matched.' + (matched ? '' : ' Good sign: the list is complete.') + '</p>';
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

  function assign(btn) {
    var row = btn.dataset.assign, sel = document.querySelector('select[data-row="' + row + '"]');
    if (!sel.value) { sel.focus(); return; }
    var s = byId[sel.value];
    if (!confirm('Match this response to "' + s.title + '" (' + s.room + ', ' + dayLabel(s.date) + ' ' + s.start + ')?\n\nThis updates the Google Sheet.')) return;
    btn.disabled = true; btn.textContent = 'Saving…';
    fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'assign', key: state.key, test: $('showTest').checked, row: +row, timestamp: btn.dataset.ts, sessionId: sel.value })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { alert('Not saved: ' + (j.error || 'unknown problem') + '.'); btn.disabled = false; btn.textContent = 'Match'; return; }
      load();
    }).catch(function () { alert('Could not reach the Google Sheet. Try again.'); btn.disabled = false; btn.textContent = 'Match'; });
  }


  /* ---------- page wiring ---------- */

  function renderAll() {
    renderOverview(); renderRankings(); renderComments(); renderScorecards(); renderTyped();
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
    if (!h.automatic) return 'Automatic processing is OFF. In the Sheet: IFC Feedback > Turn on automatic processing + hourly backups. (Nothing is lost: responses wait safely in the Raw log.)';
    var age = h.lastProcessed ? Date.now() - Date.parse(h.lastProcessed) : Infinity;
    if (h.waiting > 0 && age > 5 * 60000) return h.waiting + ' responses are waiting in the Raw log and processing last ran ' + ago(age) + '. They are safe; check the script triggers.';
    return '';
  }

  function showAlert(msg) { $('alert').textContent = msg; $('alert').hidden = !msg; }

  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('.tabs [role=tab]').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === name); });
    document.querySelectorAll('.panel').forEach(function (p) { p.hidden = p.id !== 'tab-' + name; });
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
    if (!API) { $('login').hidden = false; $('loginError').textContent = 'No Google Sheet address in config.js yet.'; return; }
    // A sign-in link carries the password after #, which never leaves the browser.
    // It is remembered on this device and then tidied out of the address bar.
    if (location.hash.length > 1) {
      try { state.key = decodeURIComponent(location.hash.slice(1)); } catch (e) { state.key = location.hash.slice(1); }
      store('local', KEY_STORE, state.key);
      history.replaceState(null, '', location.pathname + location.search);
    }
    state.key = state.key || store('session', KEY_STORE) || store('local', KEY_STORE);
    if (state.key) start(); else $('login').hidden = false;

    $('login').addEventListener('submit', function (e) {
      e.preventDefault();
      var key = $('pw').value;
      $('loginBtn').disabled = true; $('loginError').textContent = '';
      state.key = key;
      fetchData().then(function (d) {
        $('loginBtn').disabled = false;
        if (!d.ok) { $('loginError').textContent = d.message || 'That password did not work.'; return; }
        store($('remember').checked ? 'local' : 'session', KEY_STORE, key);
        state.data = d; state.lastOk = Date.now();
        $('login').hidden = true; $('app').hidden = false;
        prepare(); renderAll(); updateStatus();
        clearInterval(timer);
        timer = setInterval(function () { if (document.visibilityState === 'visible') load(); else updateStatus(); }, REFRESH_MS);
      }).catch(function () {
        $('loginBtn').disabled = false;
        $('loginError').textContent = 'Could not reach the Google Sheet. Check your connection and try again.';
      });
    });

    $('logoutBtn').addEventListener('click', function () { clearInterval(timer); signOut(''); });
    $('refreshBtn').addEventListener('click', load);
    $('showTest').addEventListener('change', load);
    ['fDay', 'fTrack', 'fRoom'].forEach(function (id) { $(id).addEventListener('change', renderAll); });
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
      if (el.dataset.sort) {
        state.sortDir = state.sortBy === el.dataset.sort ? -state.sortDir : (el.dataset.sort === 'title' || el.dataset.sort === 'when' ? 1 : -1);
        state.sortBy = el.dataset.sort; renderRankings();
      } else if (el.closest('[data-card]')) {
        state.scorecard = el.closest('[data-card]').dataset.card; renderScorecards(); showTab('scorecards'); window.scrollTo(0, 0);
      } else if (el.dataset.toggle) {
        var box = $(el.dataset.toggle); box.hidden = !box.hidden;
        el.textContent = box.hidden ? 'Show as a table' : 'Hide table';
      } else if (el.dataset.assign) assign(el);
      else if (el.id === 'exportBtn') exportCSV();
      else if (el.id === 'moreComments') { state.commentsShown += 100; renderComments(); }
      else if (el.id === 'printBtn') {
        var panel = $('tab-scorecards'); panel.classList.add('printing'); window.print(); panel.classList.remove('printing');
      }
    });
    document.querySelector('#app').addEventListener('change', function (e) {
      if (e.target.id === 'minN') { state.minN = +e.target.value; renderRankings(); }
      if (e.target.id === 'cardPick') { state.scorecard = e.target.value; renderScorecards(); }
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
