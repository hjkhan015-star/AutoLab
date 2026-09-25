/* perf-guard.js — Auto Lab */
(function () {
  'use strict';

  var HOST_ID = 'module-frame-host';

  /* ── Controller injected into every module iframe ─────────────── */
  var CONTROLLER = [
    '(function () {',
    '  if (window.__autolabPerfGuard) return;',
    '  window.__autolabPerfGuard = true;',
    '',
    '  var raf = window.requestAnimationFrame.bind(window);',
    '  var caf = window.cancelAnimationFrame.bind(window);',
    '  var paused = false;',
    '  var parked = new Map();',
    '  var uid = 0;',
    '',
    '  window.requestAnimationFrame = function (cb) {',
    '    if (!paused) return raf(cb);',
    '    var id = ++uid;',
    '    parked.set(id, cb);',
    '    return id;',
    '  };',
    '',
    '  window.cancelAnimationFrame = function (id) {',
    '    if (parked.has(id)) { parked.delete(id); return; }',
    '    return caf(id);',
    '  };',
    '',
    '  function resume() {',
    '    if (!paused) return;',
    '    paused = false;',
    '    var cbs = [];',
    '    parked.forEach(function (cb) { cbs.push(cb); });',
    '    parked.clear();',
    '    for (var i = 0; i < cbs.length; i++) raf(cbs[i]);',
    '  }',
    '',
    '  window.addEventListener("message", function (e) {',
    '    var d = e.data;',
    '    if (!d || d.source !== "auto-shell") return;',
    '    if (d.action === "perf-pause")  { paused = true; return; }',
    '    if (d.action === "perf-resume") { resume(); }',
    '  });',
    '',
    '  try {',
    '    window.parent.postMessage(',
    '      { source: "auto-module-perf", action: "perf-ready" }, "*");',
    '  } catch (_) {}',
    '})();'
  ].join('\n');

  /* ── Inject controller into an iframe document ────────────────── */
  function inject(iframe) {
    var doc;
    try { doc = iframe.contentDocument; } catch (_) { return false; }
    if (!doc || !doc.documentElement) return false;
    if (doc.getElementById('autolab-perf-guard')) return true;
    try {
      var s = doc.createElement('script');
      s.id = 'autolab-perf-guard';
      s.textContent = CONTROLLER;
      (doc.head || doc.documentElement).appendChild(s);
      return true;
    } catch (_) { return false; }
  }

  function send(iframe, action) {
    try {
      iframe.contentWindow.postMessage(
        { source: 'auto-shell', action: action }, '*');
    } catch (_) {}
  }

  function sync(iframe) {
    if (!inject(iframe)) return false;
    send(iframe, iframe.classList.contains('active')
      ? 'perf-resume'
      : 'perf-pause');
    return true;
  }

  function retry(iframe) {
    var tries = 0;
    (function attempt() {
      if (sync(iframe)) return;
      if (++tries > 150) return;
      setTimeout(attempt, 30);
    })();
  }

  function watch(iframe) {
    if (iframe.__perfWatched) return;
    iframe.__perfWatched = true;

    retry(iframe);
    iframe.addEventListener('load', function () { retry(iframe); });

    new MutationObserver(function () { sync(iframe); })
      .observe(iframe, { attributes: true, attributeFilter: ['class'] });
  }

  /* ── Match an incoming perf-ready to its iframe ───────────────── */
  function findBySource(src) {
    var host = document.getElementById(HOST_ID);
    if (!host) return null;
    var list = host.querySelectorAll('iframe');
    for (var i = 0; i < list.length; i++) {
      try { if (list[i].contentWindow === src) return list[i]; } catch (_) {}
    }
    return null;
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'auto-module-perf') return;
    if (d.action !== 'perf-ready') return;
    var fr = findBySource(e.source);
    if (fr) sync(fr);
  });

  /* ── Boot ─────────────────────────────────────────────────────── */
  function start() {
    var host = document.getElementById(HOST_ID);
    if (!host) { setTimeout(start, 200); return; }

    new MutationObserver(function () {
      var list = host.querySelectorAll('iframe');
      for (var i = 0; i < list.length; i++) watch(list[i]);
    }).observe(host, { childList: true });

    var list = host.querySelectorAll('iframe');
    for (var i = 0; i < list.length; i++) watch(list[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
