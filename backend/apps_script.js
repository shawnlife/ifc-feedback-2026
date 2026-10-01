/**
 * IFC 2026 Session Feedback: Google Sheets backend.
 *
 * REFERENCE COPY. The live version is pasted into the Google Sheet under
 * Extensions > Apps Script. See SETUP.md.
 *
 * The spreadsheet has four tabs (created by running setup once):
 *   Sessions        : the programme. Edit this during the event; the form picks
 *                     up changes within about a minute.
 *   Responses       : one row per feedback submission. Do not edit the header row.
 *   Test responses  : anything sent from the form with ?test on the end of the URL.
 *   Summary         : per-session averages, rebuilt from the "IFC Feedback" menu.
 *
 * What it deliberately does NOT store: names, emails, IP addresses, device info.
 */

var SESSIONS = 'Sessions';
var RESPONSES = 'Responses';
var TEST_RESPONSES = 'Test responses';
var SUMMARY = 'Summary';

var SESSION_HEADERS = ['ID', 'Title', 'Speakers', 'Room', 'Date', 'Start', 'End', 'Track'];
var BASE_COLUMNS = ['Timestamp', 'Session ID', 'Session', 'Speakers', 'Room', 'Date', 'Time', 'Track', 'Note'];

var CACHE_KEY = 'sessions_v1';
var CACHE_SECONDS = 60;
var MAX_ANSWERS = 20;
var MAX_TEXT = 1000;


/* ---------- menu ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('IFC Feedback')
    .addItem('Check the session list for problems', 'checkSessions')
    .addItem('Update the Summary tab', 'buildSummary')
    .addSeparator()
    .addItem('First-time setup (creates the tabs)', 'setup')
    .addToUi();
}

// Any edit to the Sessions tab clears the cache, so the form sees it straight away.
function onEdit(e) {
  if (e && e.range && e.range.getSheet().getName() === SESSIONS) {
    CacheService.getScriptCache().remove(CACHE_KEY);
  }
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(SESSIONS);
  if (!s) {
    s = ss.insertSheet(SESSIONS, 0);
    s.getRange(1, 1, 1, SESSION_HEADERS.length).setValues([SESSION_HEADERS]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  [RESPONSES, TEST_RESPONSES].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, BASE_COLUMNS.length).setValues([BASE_COLUMNS]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  if (!ss.getSheetByName(SUMMARY)) ss.insertSheet(SUMMARY);
  var blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  SpreadsheetApp.getUi().alert('Done. Paste or import the programme into the "Sessions" tab.');
}


/* ---------- reading the session list ---------- */

function readSessions_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSIONS);
  if (!sh || sh.getLastRow() < 2) return [];
  var range = sh.getDataRange();
  var values = range.getValues();
  var display = range.getDisplayValues();
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var head = values[0].map(function (h) { return String(h).trim(); });
  var idCol = head.map(function (h) { return h.toLowerCase(); }).indexOf('id');
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = {}, any = false;
    for (var c = 0; c < head.length; c++) {
      if (!head[c]) continue;
      var v = values[r][c], text;
      if (v instanceof Date) {
        // Time-only cells are stored as dates in 1899: use what the cell shows,
        // formatting them ourselves gives times that are off by minutes in Europe.
        if (v.getFullYear() < 1900) text = display[r][c];
        else if (v.getHours() === 0 && v.getMinutes() === 0) text = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        else text = Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm');
      } else {
        text = String(v).trim();
      }
      if (text) any = true;
      row[head[c]] = text;
    }
    if (!any) continue;
    if (idCol === -1 || !row[head[idCol]]) row.ID = autoId_(row);
    out.push(row);
  }
  return out;
}

// Stable ID for rows without one: the same session always gets the same ID.
function autoId_(row) {
  var key = [row.Title, row.Date, row.Room].join('|');
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, key, Utilities.Charset.UTF_8);
  return 'A' + bytes.slice(0, 4).map(function (b) { return ((b + 256) % 256).toString(16); }).join('');
}

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action !== 'sessions') return json_({ ok: true, hint: 'IFC feedback backend is running.' });
  var cache = CacheService.getScriptCache();
  var hit = cache.get(CACHE_KEY);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  var body = JSON.stringify({ ok: true, sessions: readSessions_(), updated: new Date().toISOString() });
  if (body.length < 95000) cache.put(CACHE_KEY, body, CACHE_SECONDS);
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}


/* ---------- saving a response ---------- */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return json_({ ok: false, error: 'empty' });
    if (e.postData.contents.length > 20000) return json_({ ok: false, error: 'too large' });
    var p = JSON.parse(e.postData.contents);
    var rid = String(p.rid || '').slice(0, 64);
    var s = p.session || {};
    var answers = p.answers || {};
    if (!rid || !s.title || typeof answers !== 'object') return json_({ ok: false, error: 'invalid' });

    var cache = CacheService.getScriptCache();
    if (cache.get('rid_' + rid)) return json_({ ok: true, duplicate: true }); // a retry of something already saved

    // Clean the answers
    var clean = {}, keys = Object.keys(answers).slice(0, MAX_ANSWERS), hasAnswer = false;
    keys.forEach(function (k) {
      var col = safe_(String(k).slice(0, 60));
      var v = answers[k];
      if (typeof v === 'number') v = (v >= 1 && v <= 5) ? Math.round(v) : '';
      else v = safe_(String(v == null ? '' : v).slice(0, MAX_TEXT));
      if (v !== '') hasAnswer = true;
      clean[col] = v;
    });
    if (!hasAnswer) return json_({ ok: false, error: 'no answers' });

    var id = String(s.id || '').slice(0, 64);
    var note = '';
    if (id === 'NOT LISTED') note = 'Typed in by attendee';
    else if (!sessionIds_()[id]) note = 'Session not in current list';

    var base = {
      'Timestamp': new Date(),
      'Session ID': safe_(id),
      'Session': safe_(String(s.title).slice(0, 300)),
      'Speakers': safe_(String(s.speakers || '').slice(0, 300)),
      'Room': safe_(String(s.room || '').slice(0, 100)),
      'Date': safe_(String(s.date || '').slice(0, 20)),
      'Time': safe_([s.start, s.end].filter(String).join('–').slice(0, 20)),
      'Track': safe_(String(s.track || '').slice(0, 100)),
      'Note': note
    };

    var lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      if (cache.get('rid_' + rid)) return json_({ ok: true, duplicate: true });
      var sh = responsesSheet_(p.test === true);
      var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
      Object.keys(clean).forEach(function (col) {
        if (head.indexOf(col) === -1) {
          head.push(col);
          sh.getRange(1, head.length).setValue(col).setFontWeight('bold');
        }
      });
      var row = head.map(function (h) {
        if (h in base) return base[h];
        if (h in clean) return clean[h];
        return '';
      });
      sh.appendRow(row);
      cache.put('rid_' + rid, '1', 21600);
    } finally {
      lock.releaseLock();
    }
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err).slice(0, 200) });
  }
}

function responsesSheet_(isTest) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = isTest ? TEST_RESPONSES : RESPONSES;
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, BASE_COLUMNS.length).setValues([BASE_COLUMNS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function sessionIds_() {
  var ids = {};
  var hit = CacheService.getScriptCache().get(CACHE_KEY);   // avoid re-reading the sheet on every submit
  var list = hit ? JSON.parse(hit).sessions : readSessions_();
  list.forEach(function (r) {
    var id = r.ID || r.Id || r.id;
    if (id) ids[String(id)] = true;
  });
  return ids;
}

// Stop anything typed into the form from running as a spreadsheet formula.
function safe_(v) {
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}


/* ---------- helpers for the person running it on the day ---------- */

function checkSessions() {
  var rows = readSessions_(), problems = [], seen = {};
  if (!rows.length) problems.push('The Sessions tab is empty.');
  rows.forEach(function (r, i) {
    var line = 'Row ' + (i + 2) + ': ';
    var title = r.Title || r['Session title'] || '';
    if (!title) problems.push(line + 'no title (this row will not appear in the form)');
    if (!(r.Date || r.Day)) problems.push(line + 'no date');
    var start = r.Start || r['Start time'] || r.Time || '';
    if (!start) problems.push(line + 'no start time');
    else if (!/\d{1,2}[:.h]\d{2}|\d{1,2}\s*(am|pm)/i.test(start)) problems.push(line + 'start time "' + start + '" not recognised (use 14:00)');
    if (!r.Room) problems.push(line + 'no room');
    if (r.ID && seen[r.ID]) problems.push(line + 'ID "' + r.ID + '" is also used on row ' + seen[r.ID]);
    if (r.ID) seen[r.ID] = i + 2;
  });
  var ui = SpreadsheetApp.getUi();
  if (!problems.length) ui.alert('All good: ' + rows.length + ' sessions, no problems found.');
  else ui.alert(problems.length + ' thing(s) to fix:\n\n' + problems.slice(0, 40).join('\n') +
    (problems.length > 40 ? '\n…and ' + (problems.length - 40) + ' more' : ''));
}

function buildSummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(RESPONSES);
  if (!src || src.getLastRow() < 2) { SpreadsheetApp.getUi().alert('No responses yet.'); return; }
  var data = src.getDataRange().getValues();
  var head = data[0].map(String);
  // Rating columns are the answer columns where every filled value is a number 1-5
  var ratingCols = [];
  head.forEach(function (h, c) {
    if (BASE_COLUMNS.indexOf(h) > -1 || !h) return;
    var nums = 0, other = 0;
    for (var r = 1; r < data.length; r++) {
      var v = data[r][c];
      if (v === '' || v == null) continue;
      if (typeof v === 'number' && v >= 1 && v <= 5) nums++; else other++;
    }
    if (nums && !other) ratingCols.push(c);
  });
  var col = function (name) { return head.indexOf(name); };
  var groups = {}, order = [];
  for (var r = 1; r < data.length; r++) {
    var key = data[r][col('Session ID')] + '|' + data[r][col('Session')];
    if (!groups[key]) {
      groups[key] = { row: data[r], n: 0, sums: {}, counts: {} };
      order.push(key);
    }
    var g = groups[key];
    g.n++;
    ratingCols.forEach(function (c) {
      var v = data[r][c];
      if (typeof v === 'number') { g.sums[c] = (g.sums[c] || 0) + v; g.counts[c] = (g.counts[c] || 0) + 1; }
    });
  }
  var outHead = ['Session', 'Speakers', 'Room', 'Date', 'Time', 'Responses']
    .concat(ratingCols.map(function (c) { return 'Avg ' + head[c]; }));
  var rows = order.map(function (k) {
    var g = groups[k], row = g.row;
    return [row[col('Session')], row[col('Speakers')], row[col('Room')], row[col('Date')], row[col('Time')], g.n]
      .concat(ratingCols.map(function (c) { return g.counts[c] ? Math.round(g.sums[c] / g.counts[c] * 10) / 10 : ''; }));
  });
  rows.sort(function (a, b) { return String(a[3] + a[4]).localeCompare(String(b[3] + b[4])); });
  var sh = ss.getSheetByName(SUMMARY) || ss.insertSheet(SUMMARY);
  sh.clear();
  sh.getRange(1, 1, 1, outHead.length).setValues([outHead]).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, outHead.length).setValues(rows);
  sh.setFrozenRows(1);
  sh.getRange(1, outHead.length + 2).setValue('Updated ' + new Date().toLocaleString());
  SpreadsheetApp.getUi().alert('Summary updated: ' + rows.length + ' sessions with feedback.');
}
