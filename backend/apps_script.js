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
 *   Raw log         : (hidden) MASTER COPY. Every response lands here first, exactly as
 *                     sent, then moves to Responses within a minute. Never edit it.
 *   Events          : clicks on Help / ShawnLife links and home-screen installs.
 *
 * "IFC Feedback > Turn on automatic processing + hourly backups" must be run once:
 * it moves responses every minute and copies the whole spreadsheet to a
 * separate file in your Google Drive every hour (keeps the last 48).
 *
 * Dashboard: reads everything through doPost with action "dashboard" and the
 * password set with "IFC Feedback > Set dashboard password". The password is checked
 * here, on Google's side, never in the web page.
 *
 * What it deliberately does NOT store: names, emails, IP addresses, device info.
 */

var SESSIONS = 'Sessions';
var RESPONSES = 'Responses';
var TEST_RESPONSES = 'Test responses';
var SUMMARY = 'Summary';
var RAW_LOG = 'Raw log';
var BACKUP_FOLDER = 'IFC 2026 Feedback backups';
var BACKUPS_TO_KEEP = 48;

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
    .addItem('Set dashboard password', 'setDashboardPassword')
    .addItem('Turn on automatic processing + hourly backups', 'turnOnAutomation')
    .addItem('Process new responses now', 'processQueue')
    .addItem('Back up now', 'backupNow')
    .addItem('Clear test responses', 'clearTestResponses')
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


/* ---------- receiving (fast: no queue, no waiting) ----------
 *
 * Every response is written straight to the Raw log in one step and the phone is
 * told "saved". That takes a fraction of a second and never waits for other
 * phones, so a whole room pressing Send at once is fine. Every minute (and whenever
 * the dashboard is open) processQueue() moves new Raw log rows into the Responses
 * tabs in one batch. The Raw log is the master copy: never edit it.
 */

var RAW_HEAD = ['Received', 'ID', 'Kind', 'Everything sent (JSON)', 'Status'];
var KINDS = { RESPONSE: 1, TEST: 1, EVENT: 1 };
var EVENT_TYPES = ['help', 'shawnlife', 'installed', 'tip-shown'];

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return json_({ ok: false, error: 'empty' });
    if (e.postData.contents.length > 20000) return json_({ ok: false, error: 'too large' });
    var p = JSON.parse(e.postData.contents);
    if (p.action === 'dashboard') return dashboard_(p);
    if (p.action === 'assign') return assign_(p);
    if (p.action === 'event') {
      var type = String(p.type || '');
      if (EVENT_TYPES.indexOf(type) === -1) return json_({ ok: false, error: 'unknown event' });
      return json_(rawAppend_([new Date(), '', 'EVENT', JSON.stringify({ type: type, test: p.test === true }), '']));
    }

    var rid = String(p.rid || '').slice(0, 64);
    if (!rid || !p.session || !p.session.title || typeof p.answers !== 'object') return json_({ ok: false, error: 'invalid' });
    var cache = CacheService.getScriptCache();
    if (cache.get('rid_' + rid)) return json_({ ok: true, duplicate: true });   // a retry of something already saved
    var res = rawAppend_([new Date(), rid, p.test === true ? 'TEST' : 'RESPONSE', JSON.stringify(p), '']);
    if (res.ok) cache.put('rid_' + rid, '1', 21600);
    return json_(res);
  } catch (err) {
    return json_({ ok: false, error: String(err).slice(0, 200) });
  }
}

// IMPORTANT: Google Sheets loses rows when several requests append at the same
// instant (load test 1 Oct: 800 sent, all told "saved", only 114 written).
// So every write waits its turn for this lock. The work inside is one row, kept
// as short as possible. If the lock can't be had in 25 s the phone is told
// "busy" and retries, so nothing is ever reported as saved unless it was.
function rawAppend_(row) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'busy' };
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RAW_LOG) || rawSheet_();
    sh.appendRow(row);
    SpreadsheetApp.flush();                 // make sure it is written before we say "saved"
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'busy' };
  } finally {
    lock.releaseLock();
  }
}

function rawSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(RAW_LOG);
  if (!sh) {
    sh = ss.insertSheet(RAW_LOG);
    sh.getRange(1, 1, 1, RAW_HEAD.length).setValues([RAW_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.hideSheet();
  } else if (sh.getRange(1, 5).getValue() !== 'Status') {
    sh.getRange(1, 1, 1, RAW_HEAD.length).setValues([RAW_HEAD]).setFontWeight('bold');   // upgrade old header
  }
  return sh;
}


/* ---------- processing: Raw log -> Responses / Test responses / Events ---------- */

function processQueue() {
  var lock = LockService.getDocumentLock();   // separate from the intake lock, so phones are never kept waiting by this
  if (!lock || !lock.tryLock(1000)) return 0; // another run is already doing it
  try {
    var raw = rawSheet_();
    var props = PropertiesService.getScriptProperties();
    var last = raw.getLastRow();
    var from = Number(props.getProperty('RAW_NEXT_ROW') || 2);
    if (last < from) { props.setProperty('LAST_PROCESSED', new Date().toISOString()); return 0; }

    // IDs already saved, so a resend can never create a second row
    var saved = {};
    if (from > 2) {
      raw.getRange(2, 2, from - 2, 4).getValues().forEach(function (r) { if (r[3] === 'saved') saved[r[0]] = 1; });
    }
    var block = raw.getRange(from, 1, last - from + 1, 5).getValues();
    var out = { RESPONSE: [], TEST: [], EVENT: [] }, status = [];
    var ids = sessionIds_();                    // looked up once for the whole batch
    block.forEach(function (r) {
      var kind = r[2], st = r[4];
      if (!KINDS[kind] || st) { status.push([st]); return; }        // older rows or already handled
      try {
        var p = JSON.parse(r[3]);
        if (kind === 'EVENT') { out.EVENT.push([r[0], p.type, p.test ? 'test' : '']); status.push(['saved']); return; }
        if (saved[r[1]]) { status.push(['duplicate']); return; }
        var c = clean_(p, ids);
        if (!c) { status.push(['rejected']); return; }
        c.base.Timestamp = r[0];
        out[kind].push(c);
        saved[r[1]] = 1;
        status.push(['saved']);
      } catch (err) { status.push(['rejected']); }
    });
    writeRows_(RESPONSES, out.RESPONSE);
    writeRows_(TEST_RESPONSES, out.TEST);
    if (out.EVENT.length) {
      var ev = eventsSheet_();
      ev.getRange(ev.getLastRow() + 1, 1, out.EVENT.length, 3).setValues(out.EVENT);
    }
    raw.getRange(from, 5, status.length, 1).setValues(status);
    props.setProperty('RAW_NEXT_ROW', String(last + 1));
    props.setProperty('LAST_PROCESSED', new Date().toISOString());
    return out.RESPONSE.length + out.TEST.length;
  } finally {
    lock.releaseLock();
  }
}

// Validate and tidy one response. Returns null if it is junk.
function clean_(p, ids) {
  var s = p.session || {}, answers = p.answers || {};
  var clean = {}, hasAnswer = false;
  Object.keys(answers).slice(0, MAX_ANSWERS).forEach(function (k) {
    var col = safe_(String(k).slice(0, 60));
    var v = answers[k];
    if (typeof v === 'number') v = (v >= 1 && v <= 5) ? Math.round(v) : '';
    else v = safe_(String(v == null ? '' : v).slice(0, MAX_TEXT));
    if (v !== '' && col !== 'Came from') hasAnswer = true;
    clean[col] = v;
  });
  if (!hasAnswer || !s.title) return null;
  var id = String(s.id || '').slice(0, 64);
  var note = id === 'NOT LISTED' ? 'Typed in by attendee' : (!(ids || sessionIds_())[id] ? 'Session not in current list' : '');
  return {
    base: {
      'Session ID': safe_(id),
      'Session': safe_(String(s.title).slice(0, 300)),
      'Speakers': safe_(String(s.speakers || '').slice(0, 300)),
      'Room': safe_(String(s.room || '').slice(0, 100)),
      'Date': safe_(String(s.date || '').slice(0, 20)),
      'Time': safe_([s.start, s.end].filter(String).join('–').slice(0, 20)),
      'Track': safe_(String(s.track || '').slice(0, 100)),
      'Note': note
    },
    answers: clean
  };
}

function writeRows_(name, list) {
  if (!list.length) return;
  var sh = responsesSheet_(name === TEST_RESPONSES);
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
  list.forEach(function (c) {
    Object.keys(c.answers).forEach(function (col) {
      if (head.indexOf(col) === -1) { head.push(col); sh.getRange(1, head.length).setValue(col).setFontWeight('bold'); }
    });
  });
  var rows = list.map(function (c) {
    return head.map(function (h) { return h in c.base ? c.base[h] : (h in c.answers ? c.answers[h] : ''); });
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, head.length).setValues(rows);
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

function eventsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Events');
  if (!sh) {
    sh = ss.insertSheet('Events');
    sh.getRange(1, 1, 1, 3).setValues([['When', 'What', 'Test?']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function sessionIds_() {
  var ids = {};
  var hit = CacheService.getScriptCache().get(CACHE_KEY);
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


/* ---------- dashboard (password protected) ---------- */

function auth_(p) {
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('dash_fails') || 0);
  if (fails >= 20) return { ok: false, error: 'locked', message: 'Too many wrong passwords. Try again in 15 minutes.' };
  var real = PropertiesService.getScriptProperties().getProperty('DASHBOARD_PASSWORD');
  if (!real) return { ok: false, error: 'no password', message: 'Set a password first: IFC Feedback > Set dashboard password.' };
  if (String(p.key || '') !== real) {
    cache.put('dash_fails', String(fails + 1), 900);
    Utilities.sleep(800);                               // slows down guessing
    return { ok: false, error: 'wrong password' };
  }
  return null;
}

function dashboard_(p) {
  var denied = auth_(p);
  if (denied) return json_(denied);
  try { processQueue(); } catch (err) { /* the minute trigger will catch up */ }
  var ss = SpreadsheetApp.getActiveSpreadsheet(), tz = ss.getSpreadsheetTimeZone();
  var sh = ss.getSheetByName(p.test === true ? TEST_RESPONSES : RESPONSES);
  var responses = [];
  if (sh && sh.getLastRow() > 1) {
    var data = sh.getDataRange().getValues();
    var head = data[0].map(String);
    for (var r = 1; r < data.length; r++) {
      var o = { _row: r + 1 };
      for (var c = 0; c < head.length; c++) {
        if (!head[c]) continue;
        var v = data[r][c];
        if (v instanceof Date) v = head[c] === 'Date' ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v.toISOString();
        o[head[c]] = v;
      }
      responses.push(o);
    }
  }
  var events = {}, ev = ss.getSheetByName('Events');
  if (ev && ev.getLastRow() > 1) {
    ev.getRange(2, 1, ev.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if ((r[2] === 'test') === (p.test === true)) events[r[1]] = (events[r[1]] || 0) + 1;
    });
  }
  var props = PropertiesService.getScriptProperties();
  var raw = ss.getSheetByName(RAW_LOG);
  var waiting = raw ? Math.max(0, raw.getLastRow() + 1 - Number(props.getProperty('RAW_NEXT_ROW') || 2)) : 0;
  return json_({
    ok: true, generated: new Date().toISOString(), sessions: readSessions_(), responses: responses, events: events,
    health: { lastProcessed: props.getProperty('LAST_PROCESSED'), waiting: waiting,
              automatic: ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'processQueue'; }) }
  });
}

// Dashboard "Typed in" panel: attach a typed-in response to the right session.
function assign_(p) {
  var denied = auth_(p);
  if (denied) return json_(denied);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = responsesSheet_(p.test === true);
    var row = Number(p.row);
    if (!(row >= 2 && row <= sh.getLastRow())) return json_({ ok: false, error: 'row not found' });
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    var vals = sh.getRange(row, 1, 1, head.length).getValues()[0];
    var get = function (h) { return vals[head.indexOf(h)]; };
    var ts = get('Timestamp');
    if (!(ts instanceof Date) || ts.toISOString() !== p.timestamp) return json_({ ok: false, error: 'row changed, refresh and try again' });
    var s = readSessions_().filter(function (x) { return String(x.ID) === String(p.sessionId); })[0];
    if (!s) return json_({ ok: false, error: 'session not found' });
    var typed = String(get('Note')).indexOf('Typed in') === 0 && get('Session ID') === 'NOT LISTED' ? get('Session') : '';
    var set = {
      'Session ID': s.ID, 'Session': safe_(s.Title || ''), 'Speakers': safe_(s.Speakers || ''), 'Room': safe_(s.Room || ''),
      'Date': s.Date || '', 'Time': [s.Start, s.End].filter(String).join('–'), 'Track': safe_(s.Track || ''),
      'Note': 'Typed in as "' + safe_(String(typed || get('Session'))).replace(/^'/, '') + '", matched on dashboard'
    };
    Object.keys(set).forEach(function (h) {
      var c = head.indexOf(h);
      if (c > -1) sh.getRange(row, c + 1).setValue(set[h]);
    });
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function setDashboardPassword() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('Dashboard password', 'Type the password the team will use to open the dashboard (at least 8 characters):', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var pw = res.getResponseText().trim();
  if (pw.length < 8) { ui.alert('Too short: use at least 8 characters.'); return; }
  PropertiesService.getScriptProperties().setProperty('DASHBOARD_PASSWORD', pw);
  ui.alert('Saved. Share it with the team privately (not by email to a big list).');
}


/* ---------- automatic jobs ---------- */

function turnOnAutomation() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'backupNow' || f === 'processQueue') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('backupNow').timeBased().everyHours(1).create();
  processQueue();
  backupNow();
  SpreadsheetApp.getUi().alert('Done. New responses now move into the Responses tab every minute, and the whole ' +
    'spreadsheet is copied to the "' + BACKUP_FOLDER + '" folder in your Google Drive every hour.');
}

// Kept so the old menu item name still works
function turnOnBackups() { turnOnAutomation(); }

function clearTestResponses() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Clear test responses?', 'Deletes every row in the "Test responses" tab (the real Responses tab is not touched).', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TEST_RESPONSES);
  if (sh && sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  var ev = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Events');
  if (ev && ev.getLastRow() > 1) {
    var keep = ev.getRange(2, 1, ev.getLastRow() - 1, 3).getValues().filter(function (r) { return r[2] !== 'test'; });
    ev.getRange(2, 1, ev.getLastRow() - 1, 3).clearContent();
    if (keep.length) ev.getRange(2, 1, keep.length, 3).setValues(keep);
  }
  ui.alert('Test responses cleared.');
}


function backupNow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var folders = DriveApp.getFoldersByName(BACKUP_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER);
  var name = ss.getName() + ' backup ' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
  DriveApp.getFileById(ss.getId()).makeCopy(name, folder);
  // keep only the newest copies
  var files = [], it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(BACKUPS_TO_KEEP).forEach(function (f) { f.setTrashed(true); });
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
