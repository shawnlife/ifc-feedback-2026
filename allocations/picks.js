/*
 * Masterclass picks (ifc2026survey.com/allocations): each Session Leader ranks their
 * top 3 masterclasses. The list lives in config.js (masterclassPicks). Answers go to the
 * Google Sheet's "Masterclass picks" tab and show on the dashboard. ?test sends to the
 * "Test masterclass picks" tab instead.
 */
(function () {
  'use strict';
  var CFG = window.IFC_CONFIG || {};
  var MP = CFG.masterclassPicks || { list: [] };
  var API = CFG.apiUrl;
  var TEST = /[?&]test(=|&|$)/.test(location.search);
  var RANKS = ['1st', '2nd', '3rd'];
  var STORE = 'ifc26-mc-picks';
  var $ = function (id) { return document.getElementById(id); };
  var picks = [null, null, null];                // masterclass index for 1st, 2nd, 3rd

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function save(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch (e) { /* private browsing */ } }
  function load() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } }
  function uid() { return 'mc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

  function render() {
    $('mcList').innerHTML = MP.list.map(function (m, i) {
      var r = picks.indexOf(i);
      return '<li class="mc' + (r > -1 ? ' picked' : '') + '">' +
        '<h3 class="mc-title">' + esc(m.title) + '</h3>' +
        '<span class="mc-by">' + esc(m.by) + '</span>' +
        '<p class="mc-about">' + esc(m.about) + '</p>' +
        (m.url ? '<a class="mc-more" href="' + esc(m.url) + '" target="_blank" rel="noopener noreferrer">Full description</a>' : '') +
        '<div class="ranks" role="group" aria-label="Your ranking for ' + esc(m.title) + '">' +
        RANKS.map(function (lab, k) {
          return '<button type="button" data-mc="' + i + '" data-rank="' + k + '" aria-pressed="' + (picks[k] === i) + '">' + lab + '</button>';
        }).join('') + '</div></li>';
    }).join('');
    $('yourPicks').innerHTML = '<h3>Your picks</h3><ol>' + RANKS.map(function (lab, k) {
      return '<li>' + (picks[k] != null ? esc(MP.list[picks[k]].title) : '<span class="empty-pick">Not chosen yet</span>') + '</li>';
    }).join('') + '</ol>';
  }

  function choose(i, k) {
    if (picks[k] === i) picks[k] = null;                                  // tap again to undo
    else {
      var had = picks.indexOf(i);
      if (had > -1) picks[had] = null;                                      // one rank per masterclass
      picks[k] = i;                                                         // and one masterclass per rank
    }
    $('yourPicks').classList.remove('invalid');
    render();
    draft();
  }

  function draft() { save({ name: $('pName').value, picks: picks }); }

  function fieldError(boxId, msg) {
    var b = $(boxId); b.classList.add('invalid');
    b.insertAdjacentHTML('beforeend', '<p class="q-error">' + msg + '</p>');
    return b;
  }

  function send(item, tries) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(item) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok && !j.duplicate) { var e = new Error(j.error || 'not saved'); e.code = j.code; e.final = j.error === 'invalid'; throw e; } return j; })
      .catch(function (e) {
        if (e.final || tries <= 1) throw e;
        return new Promise(function (ok) { setTimeout(ok, 2500 * (5 - tries)); }).then(function () { return send(item, tries - 1); });
      });
  }

  function submit(ev) {
    ev.preventDefault();
    document.querySelectorAll('#picksForm .invalid').forEach(function (x) { x.classList.remove('invalid'); });
    document.querySelectorAll('#picksForm .q-error').forEach(function (x) { x.remove(); });
    $('formError').textContent = '';
    var name = $('pName').value, first = null;
    if (!name) first = fieldError('nameBox', 'Please choose your name.');
    if (picks.some(function (p) { return p == null; })) { $('yourPicks').classList.add('invalid'); first = first || $('yourPicks'); }
    if (first) {
      $('formError').textContent = picks.some(function (p) { return p == null; }) ? 'Please choose a 1st, 2nd and 3rd masterclass.' : 'Please fix the highlighted fields.';
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    var choices = picks.map(function (i) { return MP.list[i].title; });
    var item = { action: 'picks', rid: uid(), test: TEST, name: name, choices: choices };
    var btn = $('sendBtn'); btn.disabled = true; btn.textContent = 'Sending…';
    send(item, 4).then(function () {
      draft();
      $('doneText').textContent = 'Thanks, ' + name + '. Your picks are in. We\'ll confirm your masterclass before the conference.';
      $('doneList').innerHTML = choices.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('');
      $('picksForm').hidden = true; $('done').hidden = false; window.scrollTo(0, 0); $('done').focus();
    }).catch(function (e) {
      $('formError').textContent = 'Your picks could not be sent just now. Check your connection and tap Send again. (Code F203' + (e.code ? ' / ' + e.code : '') + ')';
    }).then(function () { btn.disabled = false; btn.textContent = 'Send my picks'; });
  }

  function init() {
    if (MP.deadline) { $('deadline').textContent = 'Please send your picks by ' + MP.deadline + '.'; $('deadline').hidden = false; }
    if (TEST) { $('banner').textContent = 'Test mode: picks go to the "Test masterclass picks" tab, not the real list.'; $('banner').hidden = false; }
    (MP.leaders || []).slice().sort(function (a, b) { return a.localeCompare(b); }).forEach(function (n) {
      var o = document.createElement('option'); o.value = n; o.textContent = n; $('pName').appendChild(o);
    });
    var d = load();
    if (d) {                                                               // pick up where they left off
      if ((MP.leaders || []).indexOf(d.name) > -1) $('pName').value = d.name;
      if (Array.isArray(d.picks)) picks = d.picks.map(function (i) { return typeof i === 'number' && MP.list[i] ? i : null; });
    }
    render();
    $('mcList').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-mc]');
      if (b) choose(+b.dataset.mc, +b.dataset.rank);
    });
    $('pName').addEventListener('change', function () { $('nameBox').classList.remove('invalid'); $('nameBox').querySelectorAll('.q-error').forEach(function (x) { x.remove(); }); draft(); });
    $('picksForm').addEventListener('submit', submit);
    $('changeBtn').addEventListener('click', function () { $('done').hidden = true; $('picksForm').hidden = false; window.scrollTo(0, 0); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
