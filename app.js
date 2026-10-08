/* IFC 2026 Session Feedback
 *
 * Flow: find session (smart search) -> answer questions -> sent.
 * Sessions come from the Google Sheet via the Apps Script web app (or the sample
 * CSV in demo mode). Answers are queued on the phone first and then sent, so a
 * flaky conference wifi connection never loses a response.
 *
 * Settings and questions live in config.js. You should not need to edit this file.
 */
(function () {
  'use strict';

  var CFG = window.IFC_CONFIG || {};
  var API = (CFG.apiUrl || '').trim();
  var DEMO = !API;
  // Firebase Firestore: the main intake. Each response is created with its own ID as
  // the document name, so a resend can never make a duplicate.
  var FB = CFG.firebase || {};
  var FS_DOCS = FB.projectId && FB.apiKey
    ? (FB.endpoint || 'https://firestore.googleapis.com/v1') + '/projects/' + FB.projectId + '/databases/(default)/documents'
    : null;
  var DEMO_CSV = CFG.demoSessions || 'sessions-ifc2026.csv';
  var params = new URLSearchParams(location.search);
  var TEST = params.has('test');
  // Session leader form: same page, opened via /sessionleader/ (which adds ?leader)
  var LEADER = params.has('leader');
  // IFC Online form: same page, opened via /online/ (which adds ?online). Only the sessions
  // listed in config.js (online.sessions), and answers are marked Format: Online.
  var ONLINE = !LEADER && params.has('online') && !!(CFG.online && CFG.online.sessions);
  var ONLINE_IDS = ONLINE ? CFG.online.sessions.map(String) : [];
  var QUESTIONS = (LEADER ? CFG.leaderQuestions : CFG.questions) || [];
  var CONTACT = !LEADER && CFG.contactOptIn ? CFG.contactOptIn : null;    // optional "contact me" box
  var NAME_KEY = 'ifc26-leader-name';
  var NOW_OVERRIDE = params.get('now'); // e.g. ?now=2026-10-14T11:00 to test the "just finished" list

  // QR codes point at the address with ?qr on the end. Remember that for this visit,
  // then tidy it out of the address bar so a copied/shared link counts as a link.
  // Room signs (NFC tag or per-room QR) add ?room=Erasmus%203 so the form can ask
  // "Is this your session?" straight away. Read once, then tidied out of the address bar.
  var ROOM = (params.get('room') || '').trim();
  var SOURCE = (function () {
    var src = params.has('badge') ? 'Session Leader badge' : params.has('nfc') ? 'NFC tag' : params.has('qr') ? 'QR code' : params.has('app') ? 'Home screen' : null;
    try {
      if (src) sessionStorage.setItem('ifc26-src', src);
      else src = sessionStorage.getItem('ifc26-src');
    } catch (e) { /* private browsing: fine */ }
    if (params.has('qr') || params.has('app') || params.has('nfc') || params.has('room') || params.has('badge')) {
      params.delete('qr'); params.delete('app'); params.delete('nfc'); params.delete('room'); params.delete('badge');
      var qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs.replace(/=(?=&|$)/g, '') : '') + location.hash);
    }
    return src || 'Link';
  })();
  var TZ = CFG.timezone || 'Europe/Amsterdam';

  var SESSIONS_KEY = 'ifc26-sessions-v1';
  var OUTBOX_KEY = 'ifc26-outbox-v1';
  var RATED_KEY = LEADER ? 'ifc26-rated-leader-v1' : ONLINE ? 'ifc26-rated-online-v1' : 'ifc26-rated-v1';
  var RECENT_FIRST = Infinity;     // recent sessions shown above the search box (all of them, James 8 Oct)
  var RECENT_WINDOW_MIN = 150;   // sessions that ended up to 2.5h ago count as "just finished"
  var SHOW_FIRST = 10;           // results shown before "Show all"
  var REFRESH_AFTER_MS = 5 * 60 * 1000;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    q: $('q'), qClear: $('qClear'), status: $('status'), results: $('results'), listHeading: $('listHeading'),
    recent: $('recent'), qLabel: $('qLabel'),
    stepFind: $('stepFind'), stepForm: $('stepForm'), stepDone: $('stepDone'),
    chosen: $('chosen'), questions: $('questions'), formError: $('formError'), submitBtn: $('submitBtn'),
    browseBtn: $('browseBtn'), manualBtn: $('manualBtn'), againBtn: $('againBtn'),
    doneText: $('doneText'), banner: $('banner'), eventName: $('eventName')
  };

  var sessions = [];     // normalised session objects
  var dayNumbers = {};   // '2026-10-14' -> 2
  var lastFetch = 0;
  var selected = null;   // the chosen session, or {manual:true}
  var browsing = false, showRecentAll = false;


  /* ---------- small helpers ---------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }
  function banner(text) {
    els.banner.textContent = text;
    els.banner.hidden = !text;
  }


  /* ---------- dates and times (all in conference local time) ---------- */

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var MONTHS_FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  var DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  function parseDate(raw) {
    var s = norm(raw).trim();
    if (!s) return '';
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/); // 14/10/2026: day first (European)
    if (m) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + pad(+m[2]) + '-' + pad(+m[1]);
    m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})\.?(?:,?\s+(\d{4}))?/); // 14 Oct 2026
    var m2 = s.match(/([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/); // Oct 14, 2026
    var day, mon, year;
    if (m && MONTHS.indexOf(m[2].slice(0, 3)) > -1) { day = +m[1]; mon = MONTHS.indexOf(m[2].slice(0, 3)); year = m[3]; }
    else if (m2 && MONTHS.indexOf(m2[1].slice(0, 3)) > -1) { day = +m2[2]; mon = MONTHS.indexOf(m2[1].slice(0, 3)); year = m2[3]; }
    else return '';
    return (year || new Date().getFullYear()) + '-' + pad(mon + 1) + '-' + pad(day);
  }

  function parseTime(raw) {
    var s = norm(raw).replace(/\s+/g, '');
    var m = s.match(/^(\d{1,2})(?:[:.h](\d{2}))?(?::\d{2})?(am|pm|a\.m\.|p\.m\.)?$/) ||
            s.match(/(\d{1,2}):(\d{2})(?::\d{2})?(am|pm)?$/);   // "2026-10-14 14:00" from a date+time cell
    if (!m) return '';
    var h = +m[1], min = +(m[2] || 0);
    if (m[3] && m[3][0] === 'p' && h < 12) h += 12;
    if (m[3] && m[3][0] === 'a' && h === 12) h = 0;
    if (h > 23 || min > 59) return '';
    return pad(h) + ':' + pad(min);
  }

  // Minutes since 1970 for a local conference date + time, treating it as UTC.
  // Only ever compared with nowMinutes(), which uses the same trick, so it is consistent.
  function toMinutes(date, time) {
    if (!date || !time) return NaN;
    var d = date.split('-'), t = time.split(':');
    return Date.UTC(+d[0], +d[1] - 1, +d[2], +t[0], +t[1]) / 60000;
  }

  function nowMinutes() {
    if (NOW_OVERRIDE) {
      var p = NOW_OVERRIDE.split('T');
      var m = toMinutes(parseDate(p[0]), parseTime(p[1] || '12:00'));
      if (!isNaN(m)) return m;
    }
    try {
      var parts = {};
      new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date()).forEach(function (x) { parts[x.type] = x.value; });
      return toMinutes(parts.year + '-' + parts.month + '-' + parts.day, parts.hour + ':' + parts.minute);
    } catch (e) {
      return Math.floor(Date.now() / 60000);
    }
  }

  function dayLabel(date, long) {
    if (!date) return '';
    var d = date.split('-');
    var dt = new Date(Date.UTC(+d[0], +d[1] - 1, +d[2]));
    var wd = DAYS[dt.getUTCDay()], mo = MONTHS_FULL[+d[1] - 1];
    var cap = function (s) { return s[0].toUpperCase() + s.slice(1); };
    return long ? cap(wd) + ' ' + (+d[2]) + ' ' + cap(mo) : cap(wd.slice(0, 3)) + ' ' + (+d[2]) + ' ' + cap(mo.slice(0, 3));
  }
  function timeLabel(s) {
    if (!s.start) return '';
    return s.start + (s.end ? '–' + s.end : '');
  }


  /* ---------- loading sessions ---------- */

  var KEY_ALIASES = {
    id: ['id', 'session id', 'code', 'session code'],
    title: ['title', 'session title', 'session', 'session name', 'name'],
    speakers: ['speakers', 'speaker', 'speaker(s)', 'speaker names', 'speaker name(s)', 'presenters', 'presenter', 'presenter(s)', 'facilitator', 'facilitators'],
    room: ['room', 'venue', 'location', 'room name'],
    date: ['date', 'day', 'session date'],
    start: ['start', 'start time', 'starts', 'from', 'time', 'time slot', 'timeslot', 'slot'],
    end: ['end', 'end time', 'ends', 'to', 'finish'],
    track: ['track', 'topic', 'theme', 'stream', 'track/topic', 'category'],
    orgs: ['organisations', 'organizations', 'organisation', 'organization', 'company', 'companies']
  };

  function normaliseSession(raw) {
    var lower = {};
    Object.keys(raw).forEach(function (k) { lower[norm(k).trim()] = raw[k] == null ? '' : String(raw[k]).trim(); });
    var get = function (field) {
      var list = KEY_ALIASES[field];
      for (var i = 0; i < list.length; i++) if (lower[list[i]]) return lower[list[i]];
      return '';
    };
    var s = {
      id: get('id'), title: get('title'), speakers: get('speakers'), room: get('room'),
      date: parseDate(get('date')), track: get('track'), orgs: get('orgs')
    };
    var startRaw = get('start'), endRaw = get('end');
    // A single "Time" column like "09:30 - 10:45"
    var range = startRaw.split(/\s*(?:-|\u2013|\u2014|to)\s*/);
    if (range.length === 2 && !endRaw) { startRaw = range[0]; endRaw = range[1]; }
    s.start = parseTime(startRaw);
    s.end = parseTime(endRaw);
    if (!s.title) return null;
    if (!s.id) s.id = [s.date, s.start, s.room, s.title].join('|').slice(0, 120);
    return s;
  }

  function parseCSV(text) {
    var rows = [], row = [], field = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQ = false;
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    var head = rows.shift() || [];
    return rows.filter(function (r) { return r.join('').trim(); }).map(function (r) {
      var o = {};
      head.forEach(function (h, j) { o[h] = r[j] || ''; });
      return o;
    });
  }

  function setSessions(list) {
    sessions = list.map(normaliseSession).filter(Boolean);
    if (ONLINE) sessions = sessions.filter(function (s) { return ONLINE_IDS.indexOf(s.id) > -1; });
    var dates = sessions.map(function (s) { return s.date; }).filter(Boolean)
      .filter(function (d, i, a) { return a.indexOf(d) === i; }).sort();
    dayNumbers = {};
    dates.forEach(function (d, i) { dayNumbers[d] = i + 1; });
    sessions.forEach(buildIndex);
  }

  function fetchSessions() {
    var req = DEMO
      ? fetch(DEMO_CSV, { cache: 'no-cache' })
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
          .then(parseCSV)
      : fetch(API + '?action=sessions', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (!j.ok) throw new Error(j.error || 'bad response'); return j.sessions; });
    return req.then(function (list) {
      lastFetch = Date.now();
      store(SESSIONS_KEY, { t: lastFetch, list: list });
      setSessions(list);
      return true;
    });
  }

  // 1. the copy saved on this phone, 2. the copy published with the website (instant,
  // copes with any crowd), then 3. the live list from the Google Sheet in the
  // background, a few seconds apart per phone so a whole room doesn't ask at once.
  function loadSessions() {
    var cached = store(SESSIONS_KEY);
    var first;
    if (cached && cached.list && cached.list.length) {
      setSessions(cached.list);
      render();
      first = Promise.resolve();
    } else {
      els.status.textContent = 'Loading sessions…';
      first = DEMO ? Promise.resolve() : fetch(DEMO_CSV, { cache: 'no-cache' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function (text) { if (!sessions.length) { setSessions(parseCSV(text)); render(); } })
        .catch(function () { /* fine, the live list is next */ });
    }
    return first.then(function () {
      var wait = sessions.length ? Math.random() * 6000 : 0;
      return new Promise(function (ok) { setTimeout(ok, wait); });
    }).then(fetchSessions).then(render).catch(function () {
      if (sessions.length) return;
      els.status.innerHTML = '';
      banner('Could not load the session list. Check your connection and reload the page, or tap "My session isn\'t listed" below. (Code F101)');
    });
  }


  /* ---------- smart search ---------- */

  var STOP = ['the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'for', 'to', 'with', 'by', 'about',
              'session', 'talk', 'workshop', 'is', 'was', 'i', 'my', 'it', 'from'];

  function tokens(s) {
    return norm(s).replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
  }

  function timeTokens(t) {
    if (!t) return [];
    var h = +t.slice(0, 2), m = t.slice(3), h12 = h % 12 || 12, ap = h < 12 ? 'am' : 'pm';
    var out = [String(h), pad(h), pad(h) + m, h + m, h12 + ap, String(h12)];
    if (m !== '00') out.push(h12 + m + ap, h12 + m);
    return out;
  }

  function dateTokens(d) {
    if (!d) return [];
    var p = d.split('-'), dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    var wd = DAYS[dt.getUTCDay()], mo = MONTHS_FULL[+p[1] - 1];
    var out = [wd, wd.slice(0, 3), mo, mo.slice(0, 3), String(+p[2])];
    if (dayNumbers[d]) out.push('day' + dayNumbers[d]);
    return out;
  }

  // Each session gets searchable fields with weights: a speaker or room match
  // is worth more than "the word appeared somewhere".
  function buildIndex(s) {
    s._fields = [
      { w: 3, t: tokens(s.title) },
      { w: 3, t: tokens(s.speakers) },
      { w: 2.5, t: tokens(s.room) },
      { w: 2, t: tokens(s.track) },
      { w: 2, t: tokens(s.orgs) },                       // speakers' organisations
      { w: 2, t: tokens(s.id), strict: true },           // session code, e.g. 1WS14
      // strict: times and day names only match exactly or by prefix, never as typos
      // (otherwise "thursday" matches "tuesday", two letters apart)
      { w: 1.5, t: timeTokens(s.start), strict: true },
      { w: 1.2, t: dateTokens(s.date), strict: true }
    ];
    s._room = tokens(s.room).join(' ');
    s._title = tokens(s.title).join(' ');
    s._speakers = tokens(s.speakers).join(' ');
  }

  // Damerau-Levenshtein distance (typos, missing letters, swapped letters)
  function dist(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 0; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) {
      var rowMin = Infinity;
      for (j = 1; j <= b.length; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        if (d[i][j] < rowMin) rowMin = d[i][j];
      }
      if (rowMin > max) return max + 1;
    }
    return d[a.length][b.length];
  }

  // How well does one typed word match one word of a session? 0 = not at all.
  function wordMatch(q, w, strict) {
    if (q === w) return 1;
    if (/^\d+$/.test(q) && q.length <= 2) return 0;        // "4" must be exactly "4", not "14" or "45"
    if (w.indexOf(q) === 0) return q.length === 1 ? 0 : 0.85;
    if (strict) return 0;
    if (q.length >= 4 && w.indexOf(q) > 0) return 0.6;
    if (q.length >= 4 && /[a-z]/.test(q)) {
      var max = q.length >= 7 ? 2 : 1;
      if (dist(q, w, max) <= max) return 0.6;
      // typo while still typing: compare with the start of the word
      for (var L = q.length - 1; L <= q.length + 1; L++) {
        if (L < w.length && L >= 3 && dist(q, w.slice(0, L), max) <= max) return 0.5;
      }
    }
    return 0;
  }

  function prepQuery(raw) {
    var s = norm(raw)
      .replace(/\bday\s+(\d)\b/g, 'day$1')
      .replace(/\b(\d{1,2})\s*(am|pm)\b/g, '$1$2')
      .replace(/\b(\d{1,2})[:.h](\d{2})\s*(am|pm)\b/g, '$1$2$3')
      .replace(/\b(\d{1,2})[:.h](\d{2})\b/g, '$1$2');
    return tokens(s).filter(function (t) { return STOP.indexOf(t) === -1; });
  }

  function search(raw) {
    var qt = prepQuery(raw);
    if (!qt.length) return [];
    var qPhrase = qt.join(' ');
    var need = qt.length - Math.floor(qt.length / 3);   // 1->1, 2->2, 3->2, 4->3: one typo word is forgiven
    var now = nowMinutes();
    var compact = qt.length > 1 ? qt.join('') : '';          // "tik tok" -> "tiktok"
    var out = [];
    var bestIn = function (s, q) {
      var best = 0;
      s._fields.forEach(function (f) {
        for (var i = 0; i < f.t.length; i++) {
          var m = wordMatch(q, f.t[i], f.strict);
          if (m && m * f.w > best) best = m * f.w;
        }
      });
      return best;
    };
    sessions.forEach(function (s) {
      var score = 0, hits = 0;
      qt.forEach(function (q) {
        var best = bestIn(s, q);
        if (best) { hits++; score += best; }
      });
      if (compact.length >= 4 && hits < qt.length) {
        var joined = bestIn(s, compact);
        if (joined) { hits = qt.length; score = Math.max(score, joined * qt.length); }
      }
      if (hits < need) return;
      // Whole phrase bonuses: "room 4" should beat "4pm in room 7"
      if (qt.length > 1 || qPhrase.length > 3) {
        if (s._room === qPhrase || (s._room && qPhrase.indexOf(s._room) > -1)) score += 4;
        if (s._title.indexOf(qPhrase) > -1) score += 3;
        if (s._speakers.indexOf(qPhrase) > -1) score += 3;
      }
      score += timeBoost(s, now);
      out.push({ s: s, hits: hits, score: score });
    });
    out.sort(function (a, b) {
      return b.hits - a.hits || b.score - a.score || sortKey(a.s).localeCompare(sortKey(b.s));
    });
    var ranked = out.map(function (x) { return x.s; });
    return ranked.filter(isOpen).concat(ranked.filter(function (s) { return !isOpen(s); }));
  }

  // During the conference, sessions that just ended are the likeliest answer.
  function timeBoost(s, now) {
    var start = toMinutes(s.date, s.start), end = toMinutes(s.date, s.end || s.start);
    if (isNaN(start)) return 0;
    if (start <= now && now - end <= RECENT_WINDOW_MIN) return 1.5;   // on now or just finished
    if (end < now && s.date === todayISO(now)) return 0.5;           // earlier today
    return 0;
  }

  function todayISO(now) {
    var d = new Date(now * 60000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function sortKey(s) { return (s.date || '9') + (s.start || '99') + s.room + s.title; }

  function byRoom(a, b) { return a.room.localeCompare(b.room, undefined, { numeric: true }); }

  // The block that most recently ENDED (up to 2.5 hours ago): where most people rating right now were.
  function justFinished() {
    var now = nowMinutes();
    var list = sessions.filter(function (s) {
      var end = toMinutes(s.date, s.end || s.start);
      return !isNaN(end) && end <= now && now - end <= RECENT_WINDOW_MIN;
    });
    var latest = list.reduce(function (m, s) { var k = s.date + (s.end || s.start); return k > m ? k : m; }, '');
    return list.filter(function (s) { return s.date + (s.end || s.start) === latest; }).sort(byRoom);
  }

  // Sessions running right now (for people who leave early or rate during the session).
  function inProgress() {
    var now = nowMinutes();
    return sessions.filter(function (s) {
      var start = toMinutes(s.date, s.start), end = toMinutes(s.date, s.end || s.start);
      return !isNaN(start) && start <= now && now < end;
    }).sort(byRoom);
  }

  // A session can be rated once it has started. ?test (without ?now) unlocks everything for testing.
  function isOpen(s) {
    if (TEST && !NOW_OVERRIDE) return true;
    var start = toMinutes(s.date, s.start);
    return isNaN(start) || start <= nowMinutes();
  }


  /* ---------- rendering the list ---------- */

  function highlight(text, qt) {
    return String(text).split(/(\s+)/).map(function (w) {
      if (!w.trim()) return w;
      var nw = tokens(w);
      var hit = qt.length && nw.some(function (t) {
        return qt.some(function (q) { return wordMatch(q, t) > 0; });
      });
      if (!hit) return esc(w);
      var m = w.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);   // keep commas outside the highlight
      return esc(m[1]) + '<mark>' + esc(m[2]) + '</mark>' + esc(m[3]);
    }).join('');
  }

  function rated() { return store(RATED_KEY) || []; }

  function card(s, qt) {
    qt = qt || [];
    var done = rated().indexOf(s.id) > -1;
    var open = isOpen(s);
    return '<li><button type="button" class="result' + (open ? '' : ' locked') + '" data-id="' + esc(s.id) + '"' +
      (open ? '' : ' disabled') + '>' +
      '<span class="r-title">' + highlight(s.title, qt) + '</span>' +
      (s.speakers ? '<span class="r-speakers">' + highlight(s.speakers, qt) + '</span>' : '') +
      '<span class="r-meta">' +
        (s.room ? '<span class="r-room">' + highlight(s.room, qt) + '</span>' : '') +
        (s.date ? '<span>' + esc(dayLabel(s.date)) + (s.start ? ', ' + esc(timeLabel(s)) : '') + '</span>' : '') +
        (s.track ? '<span>' + highlight(s.track, qt) + '</span>' : '') +
        (done ? '<span class="r-done">✓ You rated this</span>' : '') +
        (open ? '' : '<span class="r-locked">Opens for feedback when it starts</span>') +
      '</span></button></li>';
  }

  var showAll = false;

  /* ---------- "Is this your session?" (room signs) ---------- */

  var roomAsked = false;
  function roomKey(r) { return norm(String(r).split('(')[0]).replace(/[^a-z0-9]/g, ''); }

  // The session in this room that people are most likely leaving: in progress, or the
  // latest one that ended in the last 2.5 hours.
  function roomSession(room) {
    var key = room === null ? '' : roomKey(room), now = nowMinutes(), best = null;
    sessions.forEach(function (s) {
      if (room !== null && roomKey(s.room) !== key) return;          // null = any room (IFC Online)
      var start = toMinutes(s.date, s.start), end = toMinutes(s.date, s.end || s.start);
      if (isNaN(start) || start > now || now - end > RECENT_WINDOW_MIN) return;
      if (!best || start > toMinutes(best.date, best.start)) best = s;
    });
    return best;
  }

  function askRoom() {
    roomAsked = true;
    var box = $('roomAsk'), s = roomSession(ONLINE ? null : ROOM);
    if (!s) {
      if (ONLINE) return;                          // between sessions online: the list below does the job
      box.innerHTML = '<p class="room-none">Nothing has started in <strong>' + esc(ROOM) + '</strong> yet. Find your session below.</p>';
      box.hidden = false;
      return;
    }
    box.innerHTML = (ONLINE ? '<p class="room-q">Is this the session you just watched?</p>'
                            : '<p class="room-q">You\'re in <strong>' + esc(s.room) + '</strong>. Is this your session?</p>') +
      '<div class="room-card"><span class="r-title">' + esc(s.title) + '</span>' +
      (s.speakers ? '<span class="r-speakers">' + esc(s.speakers) + '</span>' : '') +
      '<span class="r-meta"><span>' + esc(dayLabel(s.date)) + ', ' + esc(timeLabel(s)) + '</span></span></div>' +
      '<div class="room-btns"><button type="button" class="primary" id="roomYes">Yes, rate this session</button>' +
      '<button type="button" class="link" id="roomNo">No, find my session</button></div>';
    box.hidden = false;
    $('roomYes').addEventListener('click', function () { box.hidden = true; choose(s); });
    $('roomNo').addEventListener('click', function () { box.hidden = true; els.q.focus(); });
  }

  function render() {
    if (browsing) return renderBrowse();
    var raw = els.q.value;
    els.qClear.hidden = !raw;
    if (!sessions.length) return;
    if ((ROOM || ONLINE) && !roomAsked) askRoom();

    // Just finished and in progress go ABOVE the search box; search results go below it
    var fin = justFinished(), live = inProgress();
    var hasRecent = !!(fin.length || live.length);
    if (!raw.trim()) {
      var left = showRecentAll ? Infinity : RECENT_FIRST;
      var group = function (title, list) {
        var part = list.slice(0, Math.max(0, left)); left -= part.length;
        return part.length ? '<li class="group"><h3 class="list-heading">' + title + '</h3></li>' +
          part.map(function (s) { return card(s); }).join('') : '';
      };
      var total = fin.length + live.length;
      els.recent.innerHTML = group('Just finished', fin) + group('In progress now', live) +
        (!showRecentAll && total > RECENT_FIRST
          ? '<li><button type="button" class="link" id="recentMore">Show all ' + total + ' recent sessions</button></li>' : '');
      els.recent.hidden = !hasRecent;
      els.qLabel.textContent = hasRecent ? 'Can\'t find your session?' : 'Find your session';
      els.listHeading.hidden = true;
      els.results.innerHTML = '';
      els.status.textContent = hasRecent ? '' : 'Each session opens for feedback when it starts. Type below or browse to find yours.';
      return;
    }
    els.recent.hidden = true; els.recent.innerHTML = '';   // searching: results appear right under the box

    var qt = prepQuery(raw);
    var found = search(raw);
    els.listHeading.hidden = true;
    var shown = showAll ? found : found.slice(0, SHOW_FIRST);
    els.results.innerHTML = shown.map(function (s) { return card(s, qt); }).join('') +
      (found.length > shown.length
        ? '<li><button type="button" class="link" id="moreBtn">Show all ' + found.length + ' matches</button></li>' : '');
    els.status.textContent = !qt.length ? 'Keep typing…'
      : found.length === 0 ? 'No sessions match. Try a speaker\'s surname, the room, or one word from the title.'
      : found.length === 1 ? '1 session found' : found.length + ' sessions found';
  }

  function renderBrowse() {
    els.recent.hidden = true; els.recent.innerHTML = '';
    els.listHeading.hidden = true;
    els.status.textContent = 'All ' + sessions.length + ' sessions, by day and time.';
    var recent = justFinished()[0] || inProgress()[0];
    var openKey = recent ? recent.date + recent.start : '';
    var byDay = {};
    sessions.slice().sort(function (a, b) { return sortKey(a).localeCompare(sortKey(b)); }).forEach(function (s) {
      var d = s.date || 'Other';
      var slot = s.start ? timeLabel(s) : 'Time to be confirmed';
      (byDay[d] = byDay[d] || {});
      (byDay[d][slot] = byDay[d][slot] || []).push(s);
    });
    var html = '';
    Object.keys(byDay).forEach(function (d) {
      html += '<li class="day-group"><h3>' + esc(d === 'Other' ? 'Other' : dayLabel(d, true)) + '</h3>';
      Object.keys(byDay[d]).forEach(function (slot) {
        var list = byDay[d][slot];
        var open = list[0].date + list[0].start === openKey;
        var started = isOpen(list[0]);
        html += '<details class="slot' + (started ? '' : ' slot-locked') + '"' + (open ? ' open' : '') + '><summary>' + esc(slot) +
          '<span class="slot-count">' + (started ? list.length + ' sessions' : 'Not started yet') + '</span></summary><ul class="results">' +
          list.map(function (s) { return card(s); }).join('') + '</ul></details>';
      });
      html += '</li>';
    });
    els.results.innerHTML = html;
  }


  /* ---------- the form ---------- */

  var STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z"/></svg>';

  function starRow(name, legend, q, extraAttr) {
    var html = '<fieldset class="q"' + (extraAttr || '') + '><legend>' + legend + '</legend><div class="stars">';
    for (var n = 1; n <= 5; n++) {
      html += '<input type="radio" id="' + name + '_' + n + '" name="' + name + '" value="' + n + '"' + (q.required ? ' required' : '') + '>' +
        '<label for="' + name + '_' + n + '" aria-label="' + n + ' out of 5">' + STAR + '</label>';
    }
    return html + '</div><div class="scale-ends"><span>' + esc(q.low || '') + '</span><span>' + esc(q.high || '') + '</span></div></fieldset>';
  }

  // Names from the session list, e.g. "Jane Doe, John Roe" -> ['Jane Doe', 'John Roe']
  function speakerNames(s) {
    return String((s && s.speakers) || '').split(/\s*,\s*/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  // Per-speaker questions depend on the session, so they are filled in when one is chosen
  function fillSpeakers(s) {
    QUESTIONS.forEach(function (q, i) {
      if (q.type !== 'speakers') return;
      var box = $('q' + i + '_wrap'); if (!box) return;
      var names = speakerNames(s), req = q.required ? '&nbsp;<span class="req" aria-hidden="true">*</span>' : '';
      box.dataset.names = JSON.stringify(names);
      box.innerHTML = names.length
        ? names.map(function (nm, j) { return starRow('q' + i + '_s' + j, esc(q.label.replace('{name}', nm)) + req, q); }).join('')
        : starRow('q' + i + '_s0', esc(q.generalLabel || 'How would you rate the speaker(s)?') + req, q);
    });
  }

  function buildQuestions() {
    var html = '';
    QUESTIONS.forEach(function (q, i) {
      var name = 'q' + i, req = q.required ? '&nbsp;<span class="req" aria-hidden="true">*</span>' : '';
      var help = q.help ? '<p class="q-help" id="' + name + '_help">' + esc(q.help) + '</p>' : '';
      var desc = q.help ? ' aria-describedby="' + name + '_help"' : '';
      if (q.type === 'speakers') {
        html += '<div class="q-speakers" id="' + name + '_wrap" data-i="' + i + '"></div>';
      } else if (q.type === 'rating') {
        html += '<fieldset class="q" data-i="' + i + '"' + desc + '><legend>' + esc(q.label) + req + '</legend>' + help + '<div class="stars">';
        for (var n = 1; n <= 5; n++) {
          html += '<input type="radio" id="' + name + '_' + n + '" name="' + name + '" value="' + n + '"' + (q.required ? ' required' : '') + '>' +
            '<label for="' + name + '_' + n + '" aria-label="' + n + ' out of 5">' + STAR + '</label>';
        }
        html += '</div><div class="scale-ends"><span>' + esc(q.low || '') + '</span><span>' + esc(q.high || '') + '</span></div></fieldset>';
      } else if (q.type === 'choice') {
        html += '<fieldset class="q" data-i="' + i + '"' + desc + '><legend>' + esc(q.label) + req + '</legend>' + help + '<div class="choices">';
        (q.options || []).forEach(function (opt, j) {
          html += '<input type="radio" id="' + name + '_' + j + '" name="' + name + '" value="' + esc(opt) + '"' + (q.required ? ' required' : '') + '>' +
            '<label for="' + name + '_' + j + '">' + esc(opt) + '</label>';
        });
        html += '</div></fieldset>';
      } else if (q.type === 'name') {
        html += '<div class="q" data-i="' + i + '"><label for="' + name + '">' + esc(q.label) + req + '</label>' + help +
          '<input type="text" class="name-input" id="' + name + '" name="' + name + '" maxlength="100" autocomplete="name"' + desc +
          (q.required ? ' required' : '') + '></div>';
      } else {
        html += '<div class="q" data-i="' + i + '"><label for="' + name + '">' + esc(q.label) + req + '</label>' + help +
          '<textarea id="' + name + '" name="' + name + '" maxlength="1000" rows="3" placeholder="' + esc(q.placeholder || '') + '"' + desc +
          (q.required ? ' required' : '') + '></textarea></div>';
      }
    });
    els.questions.innerHTML = html;
  }

  function setupContact() {
    if (!CONTACT) return;
    $('contactLabel').textContent = CONTACT.label;
    $('contactHelp').textContent = CONTACT.help || '';
    $('contactOpt').hidden = false;
    $('privacyLine').textContent = 'Anonymous unless you choose to leave your contact details.';
    $('contactMe').addEventListener('change', function () {
      $('contactFields').hidden = !this.checked;
      if (this.checked) $('contactName').focus();
      else ['contactNameBox', 'contactEmailBox'].forEach(function (id) {
        $(id).classList.remove('invalid'); $(id).querySelectorAll('.q-error').forEach(function (x) { x.remove(); });
      });
    });
  }

  // Leaders rate several sessions: fill in their name from last time
  function prefillName() {
    QUESTIONS.forEach(function (q, i) {
      if (q.type === 'name' && $('q' + i) && !$('q' + i).value) $('q' + i).value = store(NAME_KEY) || '';
    });
  }

  // Fill stars up to the chosen one
  function paintStars(fs) {
    var val = +((fs.querySelector('input:checked') || {}).value || 0);
    fs.querySelectorAll('.stars label').forEach(function (l, k) { l.classList.toggle('on', k < val); });
  }

  function showStep(step) {
    els.stepFind.hidden = step !== 'find';
    els.stepForm.hidden = step !== 'form';
    els.stepDone.hidden = step !== 'done';
    window.scrollTo(0, 0);
  }

  function choose(s) {
    selected = s;
    els.stepForm.reset();
    fillSpeakers(s.manual ? null : s);
    prefillName();
    els.stepForm.querySelectorAll('.stars').forEach(function (st) { paintStars(st.parentNode); });
    $('contactFields').hidden = true;                                   // the reset unticked "contact me"
    els.stepForm.querySelectorAll('.invalid').forEach(function (x) { x.classList.remove('invalid'); });
    els.stepForm.querySelectorAll('.q-error').forEach(function (x) { x.remove(); });
    els.formError.textContent = '';
    var change = '<button type="button" class="link" id="changeBtn">Change</button>';
    if (s.manual) {
      els.chosen.innerHTML = '<div class="chosen-head"><span class="chosen-label">Your session</span>' + change + '</div>' +
        '<label for="manualName" class="r-speakers">Session title, speaker or room</label>' +
        '<input id="manualName" class="manual-input" maxlength="200" autocomplete="off" required>';
    } else {
      var already = rated().indexOf(s.id) > -1;
      els.chosen.innerHTML = '<div class="chosen-head"><span class="chosen-label">You\'re rating</span>' + change + '</div>' +
        '<span class="r-title">' + esc(s.title) + '</span>' +
        (s.speakers ? '<span class="r-speakers">' + esc(s.speakers) + '</span>' : '') +
        '<span class="r-meta"><span class="r-room">' + esc(s.room) + '</span>' +
        (s.date ? '<span>' + esc(dayLabel(s.date)) + (s.start ? ', ' + esc(timeLabel(s)) : '') + '</span>' : '') + '</span>' +
        (already ? '<p class="hint" style="margin:8px 0 0">You have already rated this one. Sending again adds a second response.</p>' : '');
    }
    showStep('form');
    history.pushState({ step: 'form' }, '');
    if (s.manual) $('manualName').focus();
  }

  function backToFind() {
    selected = null;
    showStep('find');
  }

  function collect() {
    var answers = {}, firstBad = null;
    els.stepForm.querySelectorAll('.invalid').forEach(function (x) { x.classList.remove('invalid'); });
    els.stepForm.querySelectorAll('.q-error').forEach(function (x) { x.remove(); });
    QUESTIONS.forEach(function (q, i) {
      var val;
      if (q.type === 'speakers') {
        var box = $('q' + i + '_wrap'), names = JSON.parse((box && box.dataset.names) || '[]'), got = [], parts = [];
        (names.length ? names : [null]).forEach(function (nm, j) {
          var v = (els.stepForm.querySelector('input[name="q' + i + '_s' + j + '"]:checked') || {}).value;
          if (!v) return;
          got.push(+v);
          if (nm) parts.push(nm + ': ' + v);
        });
        answers[q.column] = got.length ? Math.round(got.reduce(function (x, y) { return x + y; }, 0) / got.length * 10) / 10 : '';
        if (q.detailColumn) answers[q.detailColumn] = parts.join('; ');
        if (q.required && box) {                                    // each speaker needs a rating
          box.querySelectorAll('fieldset.q').forEach(function (fs) {
            if (fs.querySelector('input:checked')) return;
            fs.classList.add('invalid');
            fs.insertAdjacentHTML('beforeend', '<p class="q-error">Please answer this one.</p>');
            firstBad = firstBad || fs;
          });
        }
        return;
      }
      if (q.type === 'text' || q.type === 'name') val = ($('q' + i).value || '').trim();
      else val = (els.stepForm.querySelector('input[name="q' + i + '"]:checked') || {}).value || '';
      if (q.type === 'rating' && val) val = +val;
      answers[q.column || q.label] = val;
      if (q.required && val === '') {
        var box = els.stepForm.querySelector('.q[data-i="' + i + '"]');
        box.classList.add('invalid');
        box.insertAdjacentHTML('beforeend', '<p class="q-error">Please answer this one.</p>');
        firstBad = firstBad || box;
      }
    });
    // Optional contact details: only sent when the box is ticked
    if (CONTACT && $('contactMe').checked) {
      var cName = $('contactName').value.trim(), cEmail = $('contactEmail').value.trim();
      var bad = function (id, msg) {
        var b = $(id); b.classList.add('invalid');
        b.insertAdjacentHTML('beforeend', '<p class="q-error">' + msg + '</p>');
        firstBad = firstBad || b;
      };
      if (!cName) bad('contactNameBox', 'Please add your name, or untick the box above.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cEmail)) bad('contactEmailBox', cEmail ? 'That email address doesn\'t look right.' : 'Please add your email, or untick the box above.');
      answers['Contact me'] = 'Yes';
      answers['Contact name'] = cName;
      answers['Contact email'] = cEmail;
    }
    var manualName = '';
    if (selected.manual) {
      manualName = $('manualName').value.trim();
      if (!manualName) firstBad = firstBad || $('manualName');
    }
    return { answers: answers, manualName: manualName, firstBad: firstBad };
  }


  /* ---------- sending (queued, retried, never lost) ---------- */

  function outbox() { return store(OUTBOX_KEY) || []; }

  // Main route: Firebase. Fallback: the Google Sheet script. "Saved" only when one of them confirms.
  function send(item) {
    if (!FS_DOCS) return sendSheet(item);
    return sendFirebase(item).catch(function () { return sendSheet(item); });
  }

  function toFs(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
    if (typeof v === 'object') {
      var f = {};
      Object.keys(v).forEach(function (k) { f[k] = toFs(v[k]); });
      return { mapValue: { fields: f } };
    }
    return { stringValue: String(v) };
  }

  function sendFirebase(item) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
    var fields = toFs({ rid: item.rid, test: item.test, sentAt: item.sentAt, form: item.form || 'attendee', session: item.session, answers: item.answers, v: 1 }).mapValue.fields;
    var body = { writes: [{
      update: { name: FS_DOCS.replace(/^.*?\/projects\//, 'projects/') + '/responses/' + item.rid, fields: fields },
      currentDocument: { exists: false },                                   // create only, never overwrite
      updateTransforms: [{ fieldPath: 'received', setToServerValue: 'REQUEST_TIME' }]
    }] };
    return fetch(FS_DOCS + ':commit?key=' + encodeURIComponent(FB.apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      clearTimeout(timer);
      if (r.ok) return { ok: true };
      return r.json().catch(function () { return {}; }).then(function (j) {
        var st = j && j.error && j.error.status;
        if (r.status === 409 || st === 'ALREADY_EXISTS' || st === 'FAILED_PRECONDITION') return { ok: true, duplicate: true };
        throw new Error('firebase ' + r.status);
      });
    }, function (e) { clearTimeout(timer); throw e; });
  }

  function sendSheet(item) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 45000);   // Google can be slow at peak, but it gets there
    // text/plain avoids a CORS preflight, which Apps Script cannot answer
    return fetch(API, {
      method: 'POST', body: JSON.stringify(item),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) { return r.json(); })
      .then(function (j) { clearTimeout(timer); return j; },
            function (e) { clearTimeout(timer); throw e; });
  }

  // Only these answers from Google mean "this response itself is broken, stop trying".
  // Anything else (busy, timeout, quota, outage) keeps it queued and retries.
  var PERMANENT = ['invalid', 'too large', 'empty', 'no answers'];

  var flushing = false, retryTimer = null, attempt = 0, waitingRid = null, lastCode = '';
  // Returns a map of rid -> 'sent' | 'rejected' for the items it handled.
  function flush() {
    if (DEMO || flushing) return Promise.resolve({});
    var queue = outbox();
    if (!queue.length) return Promise.resolve({});
    flushing = true;
    clearTimeout(retryTimer);
    var results = {}, failed = false;
    var chain = Promise.resolve();
    queue.forEach(function (item) {
      chain = chain.then(function () {
        if (failed) return;
        return send(item).then(function (j) {
          lastCode = (j && !j.ok && j.code) || '';                       // e.g. S105 busy, S103 invalid: shown with F201/F202
          if (!(j && j.ok) && PERMANENT.indexOf(j && j.error) === -1) throw new Error((j && j.error) || 'busy');
          results[item.rid] = j && j.ok ? 'sent' : 'rejected';
          store(OUTBOX_KEY, outbox().filter(function (x) { return x.rid !== item.rid; }));
        }).catch(function () { failed = true; });
      });
    });
    return chain.then(function () {
      flushing = false;
      if (failed) scheduleRetry(); else attempt = 0;
      if (waitingRid && results[waitingRid] === 'sent') { done('sent'); waitingRid = null; }   // update the thank-you screen
      return results;
    });
  }

  // Retry quickly at first, then back off. The random part stops every phone in a
  // room retrying in the same second.
  function scheduleRetry() {
    var base = [3, 6, 12, 20, 30, 45, 60][Math.min(attempt, 6)] * 1000;
    attempt++;
    retryTimer = setTimeout(flush, base * (0.6 + Math.random() * 0.8));
  }

  function submit(ev) {
    ev.preventDefault();
    if (!selected) return;
    var c = collect();
    if (c.firstBad) {
      els.formError.textContent = 'Please fill in the highlighted question.';
      c.firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (els.stepForm.elements.website.value) { done('sent'); return; } // bot: pretend it worked

    var s = selected;
    var item = {
      rid: uid(),
      test: TEST,
      sentAt: new Date().toISOString(),
      session: s.manual
        ? { id: 'NOT LISTED', title: c.manualName }
        : { id: s.id, title: s.title, speakers: s.speakers, room: s.room, date: s.date, start: s.start, end: s.end, track: s.track },
      form: LEADER ? 'leader' : 'attendee',
      answers: Object.assign({}, c.answers, { 'Came from': SOURCE }, ONLINE ? { 'Format': 'Online' } : {})
    };
    QUESTIONS.forEach(function (q) { if (q.type === 'name' && c.answers[q.column || q.label]) store(NAME_KEY, c.answers[q.column || q.label]); });

    if (!s.manual) {
      var r = rated();
      if (r.indexOf(s.id) === -1) { r.push(s.id); store(RATED_KEY, r); }
    }

    if (DEMO) {
      console.log('[demo mode] would send:', item);
      done('demo');
      return;
    }

    store(OUTBOX_KEY, outbox().concat([item]));
    els.submitBtn.disabled = true;
    els.submitBtn.textContent = 'Sending…';
    flush().then(function (res) {
      els.submitBtn.disabled = false;
      els.submitBtn.textContent = 'Send feedback';
      var st = res[item.rid] || 'queued';
      waitingRid = st === 'queued' ? item.rid : null;
      done(st);
    });
  }

  function done(state) {
    els.doneText.textContent = {
      sent: 'Your feedback has been sent.',
      rejected: 'Sorry, that response could not be saved. Please try again, or tell the registration desk. (Code F202' + (lastCode ? ' / ' + lastCode : '') + ')',
      queued: 'Saved on this phone and still sending (the connection is busy). Keep this page open for a moment, or it will finish next time you open the form. (Code F201' + (lastCode ? ' / ' + lastCode : '') + ')',
      demo: 'Demo mode: nothing was saved. Connect the Google Sheet in config.js to go live.'
    }[state];
    $('doneTitle').textContent = state === 'rejected' ? 'Not sent' : 'Thank you!';
    if (state !== 'rejected' && !LEADER && !ONLINE) showHomeTip();
    showStep('done');
    history.replaceState({ step: 'done' }, '');
    $('stepDone').focus();
  }


  /* ---------- wiring ---------- */

  // Logos and banner from config.js; anything missing or broken just stays hidden
  function applyBrand() {
    var b = CFG.brand || {};
    var show = function (id, src, alt) {
      var img = $(id);
      if (!src || !img) return;
      img.alt = alt || '';
      if (id === 'bannerImg') {                       // hold the photo's space from the start so the page doesn't jump when it arrives
        $('hero').hidden = false;
        img.onerror = function () { $('hero').hidden = true; };
      }
      img.onload = function () {
        img.hidden = false;
        if (id === 'bannerImg') $('hero').hidden = false;
        else { $('brandbar').hidden = false; if (id === 'logoLeft') $('eventName').hidden = true; }  // logo already says IFC 2026
      };
      img.src = src;
    };
    show('logoLeft', b.logoLeft, b.logoLeftAlt);
    show('logoRight', b.logoRight, b.logoRightAlt);
    show('bannerImg', b.banner, '');
  }

  // Help link: the address is put together here so it is not sitting in the page for spam bots
  function setupHelp() {
    var addr = ['shawnlifebiz', 'gmail.com'].join('@');
    var link = $('helpLink');
    link.target = '_blank'; link.rel = 'noopener';               // webmail opens in a new tab, the form stays put
    var setHref = function () {
      var shown = (document.body.innerText.match(/\(Code [A-Z0-9 \/]+\)/) || [''])[0];   // any problem code on screen
      link.href = 'mailto:' + addr + '?subject=' + encodeURIComponent('IFC 2026 feedback form: help') +
        '&body=' + encodeURIComponent('What happened?\n\n\nWhich session were you trying to rate (if any)?\n\n' +
          (shown ? '\n' + shown.replace(/[()]/g, '') + '\n' : ''));
    };
    setHref();
    link.addEventListener('click', function () { setHref(); track('help'); });
    $('shawnLink').addEventListener('click', function () { track('shawnlife'); });
  }

  // Anonymous counts for the dashboard (help clicks, ShawnLife clicks, home-screen
  // installs). Just "it happened", nothing about who. Fire-and-forget.
  function track(type) {
    if (DEMO || !navigator.sendBeacon) return;
    try { navigator.sendBeacon(API, JSON.stringify({ action: 'event', type: type, test: TEST })); } catch (e) { /* never matters */ }
  }
  window.addEventListener('appinstalled', function () { track('installed'); });

  // "Add to home screen" tip on the thank-you screen
  var installPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installPrompt = e; });
  // Steps for the browser this person is actually using
  function homeSteps(b) {
    var ua = navigator.userAgent;
    var ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) {
      if (/CriOS/.test(ua)) return 'In Chrome: tap the ' + b('Share') + ' button in the address bar at the top (or the ' + b('•••') + ' menu), then ' + b('Add to Home Screen') + '.';
      if (/FxiOS/.test(ua)) return 'In Firefox: tap the ' + b('☰') + ' menu, then ' + b('Share') + ', then ' + b('Add to Home Screen') + '.';
      if (/EdgiOS/.test(ua)) return 'In Edge: tap the ' + b('•••') + ' menu, then ' + b('Share') + ', then ' + b('Add to Home Screen') + '.';
      return 'In Safari: tap the ' + b('Share') + ' button (or ' + b('•••') + ' then ' + b('Share') + '), then ' + b('Add to Home Screen') + '.';
    }
    if (/Android/.test(ua)) {
      if (/SamsungBrowser/.test(ua)) return 'In Samsung Internet: tap the ' + b('☰') + ' menu, then ' + b('Add page to') + ', then ' + b('Home screen') + '.';
      if (/Firefox/.test(ua)) return 'In Firefox: tap the ' + b('⋮') + ' menu, then ' + b('Add app to Home screen') + '.';
      return 'In Chrome: tap the ' + b('⋮') + ' menu (top right), then ' + b('Add to Home screen') + ' or ' + b('Install app') + '.';
    }
    return 'On a phone, open the browser menu and choose ' + b('Add to Home Screen') + '. On a computer, bookmark this page.';
  }

  function showHomeTip() {
    var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
    if (standalone) return;                                  // already on the home screen
    var b = function (t) { return '<strong>' + t + '</strong>'; };
    $('tipSteps').innerHTML = installPrompt ? 'Or tap the button above.' : homeSteps(b);
    $('installBtn').hidden = !installPrompt;
    if ($('homeTip').hidden) track('tip-shown');
    $('homeTip').hidden = false;
  }

  function init() {
    setupHelp();
    els.eventName.textContent = CFG.eventName || 'IFC 2026';
    if (LEADER) {
      document.title = (CFG.eventName || 'IFC 2026') + ' Session Leader Feedback';
      document.querySelector('h1').textContent = 'Session Leader feedback';
      $('findLabel').textContent = 'Which session were you leading?';
      document.querySelector('#stepForm .privacy').textContent = 'Your name is only seen by the IFC team.';
      $('anonNote').textContent = 'For IFC 2026 Session Leaders.';
      els.againBtn.textContent = 'Report on another session';
    }
    if (ONLINE) {
      document.title = (CFG.eventName || 'IFC 2026') + ' Online Feedback';
      document.querySelector('h1').textContent = CFG.online.title || 'IFC Online feedback';
      $('findLabel').textContent = 'Which session did you watch?';
      document.body.classList.add('online');                       // rooms mean nothing online: hidden in CSS
      $('qHint').textContent = 'Type anything you remember: speaker, topic or time.';
      els.q.placeholder = 'e.g. Rashad, Islamic finance, 10:30';
    }
    applyBrand();
    if (DEMO) banner('Demo mode: nothing is saved.');
    else if (TEST) banner('Test mode: responses go to the "Test responses" tab, not the real results.');
    buildQuestions();
    setupContact();

    var timer;
    els.q.addEventListener('input', function () {
      browsing = false; showAll = false;
      clearTimeout(timer);
      timer = setTimeout(render, 60);
    });
    els.q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var first = els.results.querySelector('.result');
        if (first) first.focus();
      }
    });
    els.qClear.addEventListener('click', function () {
      els.q.value = ''; browsing = false; render(); els.q.focus();
    });
    els.browseBtn.addEventListener('click', function () {
      els.q.value = ''; browsing = true; render();
      els.status.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    els.manualBtn.addEventListener('click', function () { choose({ manual: true }); });
    var pickResult = function (e) {
      if (e.target.id === 'moreBtn') { showAll = true; render(); return; }
      if (e.target.id === 'recentMore') { showRecentAll = true; render(); return; }
      var b = e.target.closest('.result');
      if (!b) return;
      var s = sessions.filter(function (x) { return x.id === b.dataset.id; })[0];
      if (s) choose(s);
    };
    els.results.addEventListener('click', pickResult);
    els.recent.addEventListener('click', pickResult);

    els.stepForm.addEventListener('change', function (e) {
      var fs = e.target.closest('.q');
      if (fs && fs.querySelector('.stars')) paintStars(fs);
      if (fs && fs.classList.contains('invalid')) {
        fs.classList.remove('invalid');
        var err = fs.querySelector('.q-error'); if (err) err.remove();
        if (!els.stepForm.querySelector('.invalid')) els.formError.textContent = '';
      }
    });
    els.stepForm.addEventListener('click', function (e) {
      if (e.target.id === 'changeBtn') history.back();
    });
    els.stepForm.addEventListener('submit', submit);
    $('installBtn').addEventListener('click', function () {
      if (!installPrompt) return;
      installPrompt.prompt();
      installPrompt.userChoice.then(function () { installPrompt = null; $('homeTip').hidden = true; });
    });
    els.againBtn.addEventListener('click', function () {
      $('roomAsk').hidden = true;
      els.q.value = ''; browsing = false; render(); backToFind();
    });
    window.addEventListener('popstate', function () {
      if (els.stepFind.hidden) { render(); backToFind(); }
    });

    // Retry anything left in the outbox, and keep the session list fresh
    window.addEventListener('online', flush);
    setInterval(flush, 30000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      flush();
      if (Date.now() - lastFetch > REFRESH_AFTER_MS) fetchSessions().then(render).catch(function () {});
    });

    loadSessions();
    flush();
  }

  init();
})();
