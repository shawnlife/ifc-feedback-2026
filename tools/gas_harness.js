#!/usr/bin/env node
/*
 * Runs the REAL backend/apps_script.js against stand-ins for Google Sheets,
 * Firebase (Firestore REST), locks, cache, settings and email, then checks the
 * behaviour that matters: nothing lost, nothing doubled, quotas respected.
 *
 *     node tools/gas_harness.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let fails = 0;
function check(ok, msg) { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; }

/* ---------- fake Google environment ---------- */
function makeEnv() {
  const calls = { props: 0, fsQueries: 0, fsReads: 0, mail: [] };
  let now = Date.parse('2026-10-22T10:00:00Z');
  const clock = { now: () => now, advance: (ms) => { now += ms; } };

  class Range {
    constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr: nr || 1, nc: nc || 1 }); }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.sh.rows[this.r - 1 + i] || [];
        out.push(Array.from({ length: this.nc }, (_, j) => (row[this.c - 1 + j] === undefined ? '' : row[this.c - 1 + j])));
      }
      return out;
    }
    getDisplayValues() { return this.getValues().map((r) => r.map(String)); }
    getValue() { return this.getValues()[0][0]; }
    setValues(v) {
      v.forEach((row, i) => {
        const rr = this.r - 1 + i;
        this.sh.rows[rr] = this.sh.rows[rr] || [];
        row.forEach((x, j) => { this.sh.rows[rr][this.c - 1 + j] = x; });
      });
      return this;
    }
    setValue(x) { return this.setValues([[x]]); }
    setFontWeight() { return this; }
    clearContent() { for (let i = 0; i < this.nr; i++) { const row = this.sh.rows[this.r - 1 + i]; if (row) for (let j = 0; j < this.nc; j++) row[this.c - 1 + j] = ''; } return this; }
  }
  class Sheet {
    constructor(name) { this.name = name; this.rows = []; }
    getName() { return this.name; }
    getLastRow() { let n = this.rows.length; while (n && !(this.rows[n - 1] || []).some((x) => x !== '' && x !== undefined)) n--; return n; }
    getLastColumn() { return Math.max(0, ...this.rows.map((r) => (r || []).length)); }
    getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
    getDataRange() { return new Range(this, 1, 1, this.getLastRow(), this.getLastColumn()); }
    appendRow(row) { this.rows[this.getLastRow()] = row.slice(); }
    setFrozenRows() {} hideSheet() {}
    insertRowAfter(n) { this.rows.splice(n, 0, []); }
    deleteRows(start, count) {
      if (start === 2 && count >= this.getLastRow() - 1 && this.rows.length - 1 <= count) throw new Error('Sorry, it is not possible to delete all non-frozen rows.');
      this.rows.splice(start - 1, count);
    }
  }
  const sheets = {};
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new Sheet(n)),
    getSpreadsheetTimeZone: () => 'Europe/Amsterdam',
    getSheets: () => Object.values(sheets), getId: () => 'SHEET', getUrl: () => 'https://docs.google.com/x', getName: () => 'IFC',
    deleteSheet: (s) => { delete sheets[s.name]; }
  };
  const store = {};
  const firestore = { docs: [], fail: null };     // docs: {name, fields, createTime}

  const fromTs = (v) => v.timestampValue;
  function runQuery(body) {
    calls.fsQueries++;
    if (firestore.fail) return { code: firestore.fail, text: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' };
    const q = body.structuredQuery;
    let docs = firestore.docs.slice();
    if (q.where) docs = docs.filter((d) => d.fields.received.timestampValue >= fromTs(q.where.fieldFilter.value));
    docs.sort((a, b) => (a.fields.received.timestampValue + a.name).localeCompare(b.fields.received.timestampValue + b.name));
    if (q.startAt) {
      const [t, n] = q.startAt.values;
      docs = docs.filter((d) => { const k = d.fields.received.timestampValue; return k > t.timestampValue || (k === t.timestampValue && d.name > n.referenceValue); });
    }
    docs = docs.slice(0, q.limit || 1e9);
    calls.fsReads += Math.max(1, docs.length);
    return { code: 200, text: JSON.stringify(docs.length ? docs.map((d) => ({ document: d })) : [{ readTime: 'x' }]) };
  }

  const g = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {}, getUi: () => ({ alert() { return 'YES'; }, ButtonSet: {}, Button: { YES: 'YES' } }) },
    LockService: (() => { const mk = () => ({ held: false, tryLock() { if (this.held) return false; this.held = true; return true; }, waitLock() { this.held = true; }, releaseLock() { this.held = false; } });
      const sl = mk(), dl = mk(); return { getScriptLock: () => sl, getDocumentLock: () => dl }; })(),
    CacheService: (() => { const c = {}; return { getScriptCache: () => ({ get: (k) => c[k] || null, put: (k, v) => { c[k] = v; }, remove: (k) => { delete c[k]; } }) }; })(),
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => { calls.props++; return k in store ? store[k] : null; },
      setProperty: (k, v) => { calls.props++; store[k] = String(v); },
      deleteProperty: (k) => { calls.props++; delete store[k]; },
      getProperties: () => { calls.props++; return Object.assign({}, store); },
      setProperties: (o) => { calls.props++; Object.assign(store, o); }
    }) },
    UrlFetchApp: { fetch: (url, opt) => { const r = runQuery(JSON.parse(opt.payload)); return { getResponseCode: () => r.code, getContentText: () => r.text }; } },
    ScriptApp: { getOAuthToken: () => 'token', getProjectTriggers: () => [{ getHandlerFunction: () => 'processQueue' }], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }), everyHours: () => ({ create() {} }) }) }), deleteTrigger() {} },
    Utilities: { formatDate: (d, tz, f) => f === 'H' ? String((new Date(d).getUTCHours() + 2) % 24) : new Date(d).toISOString().slice(0, 10), sleep() {}, computeDigest: () => [1, 2, 3, 4], DigestAlgorithm: {}, Charset: {} },
    ContentService: { createTextOutput: (t) => ({ setMimeType() { return this; }, text: t }), MimeType: { JSON: 'json' } },
    MailApp: { sendEmail: (to, subject, body) => calls.mail.push({ to, subject, body }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'shawn@example.com' }) },
    DriveApp: { getFoldersByName: () => ({ hasNext: () => false }), createFolder: () => ({ getFiles: () => ({ hasNext: () => false }) }), getFileById: () => ({ makeCopy() {} }) },
    Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(clock.now()); } static now() { return clock.now(); } }
  };
  const ctx = vm.createContext(g);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', 'apps_script.js'), 'utf8'), ctx);
  // the Sessions tab with a few sessions
  const sess = ss.insertSheet('Sessions');
  sess.rows = [['ID', 'Title', 'Speakers', 'Room', 'Date', 'Start', 'End', 'Track'],
    ['1WS1', 'Fundraising Benchmarks', 'A, B', 'Boston 11', '2026-10-21', '15:30', '16:45', 'Core'],
    ['2WS1', 'Hopeful Legacies', 'C', 'Boston 11', '2026-10-22', '09:00', '10:15', 'Core']];
  store.DASHBOARD_PASSWORD = 'pw12345678';
  return { ctx, ss, sheets, store, calls, clock, firestore };
}

let n = 0;
function fsDoc(env, { test = true, form, sessionId = '1WS1', overall = 4, at } = {}) {
  n++;
  const rid = 'r' + String(n).padStart(5, '0');
  const ts = new Date(at || env.clock.now() + n).toISOString().replace('Z', '123Z');   // microsecond-style like Firestore
  const s = (v) => ({ stringValue: v });
  const fields = {
    rid: s(rid), test: { booleanValue: test }, sentAt: s('x'), received: { timestampValue: ts },
    session: { mapValue: { fields: { id: s(sessionId), title: s(sessionId === '1WS1' ? 'Fundraising Benchmarks' : 'Hopeful Legacies') } } },
    answers: { mapValue: { fields: { 'Overall (1-5)': { integerValue: String(overall) }, 'Came from': s('QR code') } } }
  };
  if (form) fields.form = s(form);
  env.firestore.docs.push({ name: 'projects/p/databases/(default)/documents/responses/' + rid, fields, createTime: ts });
  return rid;
}
const tick = (env) => { env.clock.advance(5 * 60000); env.ctx.processQueue({ triggerUid: 1 }); };   // the robot now runs every 5 minutes
const rowsOf = (env, tab) => { const sh = env.sheets[tab]; return sh ? Math.max(0, sh.getLastRow() - 1) : 0; };

/* ---------- scenarios ---------- */
console.log('1. Firebase responses reach the Sheet, each read once');
let env = makeEnv();
for (let i = 0; i < 50; i++) fsDoc(env);
tick(env);
check(rowsOf(env, 'Test responses') === 50, `50 in Firebase -> ${rowsOf(env, 'Test responses')} in Test responses`);
const readsAfterFirst = env.calls.fsReads;
for (let i = 0; i < 10; i++) tick(env);
check(rowsOf(env, 'Test responses') === 50, 'ten quiet minutes later: still 50, no duplicates');
check(env.calls.fsReads - readsAfterFirst <= 10, `quiet minutes cost ${env.calls.fsReads - readsAfterFirst} reads (1 per check)`);

console.log('2. A burst of 1,200 in one minute (bigger than one page / one slice)');
env = makeEnv();
for (let i = 0; i < 1200; i++) fsDoc(env, { at: env.clock.now() + i });
for (let i = 0; i < 4; i++) tick(env);
check(rowsOf(env, 'Test responses') === 1200, `1,200 sent -> ${rowsOf(env, 'Test responses')} in the Sheet`);
check(env.calls.fsReads <= 1200 + 20, `Firebase reads used: ${env.calls.fsReads} (about one per response)`);

console.log('3. Same response through both routes counts once');
env = makeEnv();
const rid = fsDoc(env);
const payload = { rid, test: true, session: { id: '1WS1', title: 'Fundraising Benchmarks' }, answers: { 'Overall (1-5)': 4 } };
env.ctx.doPost({ postData: { contents: JSON.stringify(payload) } });
tick(env);
check(rowsOf(env, 'Test responses') === 1, `Sheet route + Firebase for one response -> ${rowsOf(env, 'Test responses')} row`);

console.log('4. Leader reports go to their own tab, attendees to theirs');
env = makeEnv();
fsDoc(env, { form: 'leader' }); fsDoc(env, { form: 'leader', test: false }); fsDoc(env, { test: false }); fsDoc(env);
tick(env);
check(rowsOf(env, 'Test leader feedback') === 1 && rowsOf(env, 'Session leader feedback') === 1 && rowsOf(env, 'Responses') === 1 && rowsOf(env, 'Test responses') === 1,
  'leader/test-leader/real/test each landed in the right tab');

console.log('5. Settings calls stay low (Google allows ~50,000 a day)');
env = makeEnv();
tick(env); const p0 = env.calls.props;
for (let i = 0; i < 10; i++) tick(env);
const perRun = (env.calls.props - p0) / 10;
check(perRun <= 3, `idle run uses ${perRun} settings calls (x 1,440 runs = ${Math.round(perRun * 1440)}/day)`);

console.log('6. Firebase failing: alert email after 20 minutes, at most hourly');
env = makeEnv();
env.firestore.fail = 429;
for (let i = 0; i < 4; i++) tick(env);
check(env.calls.mail.length === 0, 'no email in the first 20 minutes');
for (let i = 0; i < 2; i++) tick(env);
check(env.calls.mail.length === 1, `one email after it has been failing 20+ minutes (${env.calls.mail.length})`);
for (let i = 0; i < 6; i++) tick(env);
check(env.calls.mail.length === 1, 'no repeat within the hour');
env.firestore.fail = null; fsDoc(env); tick(env);
check(rowsOf(env, 'Test responses') === 1 && !env.store.FS_LAST_ERROR, 'when Firebase recovers, the backlog comes through and the error clears');

console.log('7. Dashboard: data, leaders and usage meter');
env = makeEnv();
fsDoc(env, { test: false }); fsDoc(env, { test: false, form: 'leader' });
const out = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'dashboard', key: 'pw12345678' }) } }).text);
check(out.ok && out.responses.length === 1 && out.leaders.length === 1, 'dashboard returns 1 response + 1 leader report (and processed them on the way)');
check(out.health && out.health.usage && typeof out.health.usage.firebaseReads === 'number', `usage meter present: ${JSON.stringify(out.health.usage)}`);
const bad = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'dashboard', key: 'wrong' }) } }).text);
check(!bad.ok, 'wrong password refused');

console.log('8. Clear test responses');
env = makeEnv();
for (let i = 0; i < 5; i++) fsDoc(env);
tick(env);
env.ctx.clearTestResponses();
check(rowsOf(env, 'Test responses') === 0 && env.sheets['Test responses'].rows[0][0] === 'Timestamp', 'test rows gone, header kept, no error');

console.log('9. Junk and repeats on the Sheet route');
env = makeEnv();
const r1 = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ rid: 'abc', test: false, session: { id: '1WS1', title: 'X' }, answers: { 'Overall (1-5)': 5 } }) } }).text);
const r2 = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ rid: 'abc', test: false, session: { id: '1WS1', title: 'X' }, answers: { 'Overall (1-5)': 5 } }) } }).text);
const r3 = JSON.parse(env.ctx.doPost({ postData: { contents: '{"rid":"z"}' } }).text);
const r4 = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ rid: 'f', session: { title: 'X' }, answers: { 'Key takeaway': '=HYPERLINK("x")' } }) } }).text);
tick(env);
const resp = env.sheets['Responses'];
check(r1.ok && r2.duplicate && !r3.ok, 'saved / recognised repeat / refused junk');
check(rowsOf(env, 'Responses') === 2 && JSON.stringify(resp.rows).indexOf("'=HYPERLINK") > -1, 'formula typed into a comment is neutralised');

console.log('10. A whole worst-case Thursday: 6 blocks x 800 responses + 100 leader reports');
env = makeEnv();
let total = 0;
for (let block = 0; block < 6; block++) {
  for (let i = 0; i < 800; i++) { fsDoc(env, { test: false, at: env.clock.now() + i * 300 }); total++; }   // arrive over ~4 minutes
  for (let i = 0; i < 16; i++) { fsDoc(env, { test: false, form: 'leader', at: env.clock.now() + i * 1000 }); total++; }
  for (let m = 0; m < 30; m++) tick(env);                         // 2.5 hours until the next block
}
console.log('11. Overnight: robot sleeps, nothing is missed');
env = makeEnv();
env.clock.advance(Date.parse('2026-10-22T20:30:00Z') - env.clock.now());   // 22:30 in Amsterdam
for (let i = 0; i < 20; i++) fsDoc(env, { test: false, at: env.clock.now() + i * 1000 });
const q0 = env.calls.fsQueries;
for (let m = 0; m < 48; m++) tick(env);                                     // 22:30 -> 02:30
check(env.calls.fsQueries === q0 && rowsOf(env, 'Responses') === 0, `22:30-02:30: robot asleep (${env.calls.fsQueries - q0} Firebase checks), 20 responses waiting safely in Firebase`);
const dash = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'dashboard', key: 'pw12345678' }) } }).text);
check(dash.responses.length === 20, 'opening the dashboard at 02:30 still pulls them all through');
fsDoc(env, { test: false });
for (let m = 0; m < 60; m++) tick(env);                                     // 02:30 -> 07:30
check(rowsOf(env, 'Responses') === 21, `by 07:30 the one sent at 02:30 is in too (${rowsOf(env, 'Responses')})`);
check(env.calls.fsQueries - q0 <= 10, `whole night cost ${env.calls.fsQueries - q0} Firebase checks`);

console.log('12. Two Session Leaders report on the same session');
env = makeEnv();
fsDoc(env, { test: false, form: 'leader', sessionId: '1WS1' }); fsDoc(env, { test: false, form: 'leader', sessionId: '1WS1' });
tick(env);
const two = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'dashboard', key: 'pw12345678' }) } }).text);
check(rowsOf(env, 'Session leader feedback') === 2 && two.leaders.filter((l) => l['Session ID'] === '1WS1').length === 2, 'both reports kept and returned for that session');

console.log('13. Typed-in: No match keeps the row, Restore brings it back');
env = makeEnv();
env.ctx.doPost({ postData: { contents: JSON.stringify({ rid: 'typed1', test: false, session: { id: 'NOT LISTED', title: 'Evening drinks talk' }, answers: { 'Overall (1-5)': 4 } }) } });
tick(env);
const dsh = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'dashboard', key: 'pw12345678' }) } }).text);
const typedRow = dsh.responses.find((r) => r['Session ID'] === 'NOT LISTED');
const nm = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'assign', key: 'pw12345678', row: typedRow._row, timestamp: typedRow.Timestamp, sessionId: '__NO_MATCH__' }) } }).text);
const after = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'dashboard', key: 'pw12345678' }) } }).text).responses.find((r) => r.Session === 'Evening drinks talk');
check(nm.ok && after && /no match/.test(after.Note) && rowsOf(env, 'Responses') === 1, 'marked "no match", still in the Sheet');
env.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'assign', key: 'pw12345678', row: typedRow._row, timestamp: typedRow.Timestamp, sessionId: '__RESTORE__' }) } });
const back = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'dashboard', key: 'pw12345678' }) } }).text).responses.find((r) => r.Session === 'Evening drinks talk');
check(back && back.Note === 'Typed in by attendee', 'Restore puts it back in the to-be-matched list');

console.log('\n' + (fails ? fails + ' FAILED' : 'ALL PASSED'));
process.exit(fails ? 1 : 0);
