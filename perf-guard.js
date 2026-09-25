/* ═══════════════════════════════════════════════════════════════════════
   perf-guard.js — Auto Lab
   ───────────────────────────────────────────────────────────────────────
   Pauses the requestAnimationFrame loop of every hidden module iframe,
   and resumes it when the iframe becomes visible again.

   WHY
   ---
   index.html hides inactive iframes with display:none, but display:none
   does NOT stop JavaScript. Every module keeps rendering at 60 fps even
   when invisible — so after visiting a few modules, N scenes are all
   rendering concurrently and the frame rate collapses.

   HOW
   ---
   1. Watches #module-frame-host for iframes.
   2. On each iframe load, injects a small controller into its document.
   3. The controller wraps requestAnimationFrame. On "perf-pause" it parks
      the module's next rAF callback; on "perf-resume" it replays it.
   4. A MutationObserver on the iframe's `class` attribute syncs state:
      class "active" present → resume; absent → pause.

   No module code changes. No CSS changes. One script tag in index.html.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const HOST_ID = 'module-frame-host';

  /* ── Controller injected into every module iframe ──────────────── */
  const CONTROLLER_SOURCE = `
  (function () {
    if (window.__autolabPerfGuard) return;
    window.__autolabPerfGuard = true;

    var origRAF = window.requestAnimationFrame.bind(window);
    var paused  = false;
    var parked  = [];

    window.requestAnimationFrame = function (cb) {
      if (paused) { parked.push(cb); return -1; }
      return origRAF(cb);
    };

    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.source !== 'auto-shell') return;

      if (d.action === 'perf-pause') {
        if (paused) return;
        paused = true;
        return;
      }

      if (d.action === 'perf-resume') {
        if (!paused) return;
        paused = false;
        var q = parked.slice();
        parked.length = 0;
        for (var i = 0; i < q.length; i++) origRAF(q[i]);
      }
    });
  })();
  `;

  /* ── Inject controller into an iframe's document ───────────────── */
  function injectController(iframe) {
    let doc;
    try { doc = iframe.contentDocument; } catch (_) { return false; }
    if (!doc || !doc.documentElement) return false;
    if (doc.getElementById('autolab-perf-guard-script')) return true;

    try {
      const s = doc.createElement('script');
      s.id = 'autolab-perf-guard-script';
      s.textContent = CONTROLLER_SOURCE;
      (doc.head || doc.documentElement).appendChild(s);
      return true;
    } catch (_) {
      return false;
    }
  }

  /* ── Pause / resume messages ───────────────────────────────────── */
  function sendPause(iframe) {
    try {
      iframe.contentWindow.postMessage(
        { source: 'auto-shell', action: 'perf-pause' },
        '*'
      );
    } catch (_) {}
  }

  function sendResume(iframe) {
    try {
      iframe.contentWindow.postMessage(
        { source: 'auto-shell', action: 'perf-resume' },
        '*'
      );
    } catch (_) {}
  }

  /* ── Sync one iframe's pause state ─────────────────────────────── */
  function syncState(iframe) {
    if (iframe.classList.contains('active')) sendResume(iframe);
    else                                      sendPause(iframe);
  }

  /* ── Attach watcher to one iframe ──────────────────────────────── */
  function attachWatcher(iframe) {
    if (iframe.__autolabPerfWatched) return;
    iframe.__autolabPerfWatched = true;

    function tryInject() {
      if (!injectController(iframe)) {
        setTimeout(tryInject, 40);
        return;
      }
      syncState(iframe);
    }

    tryInject();
    iframe.addEventListener('load', tryInject);

    const classMO = new MutationObserver(() => syncState(iframe));
    classMO.observe(iframe, { attributes: true, attributeFilter: ['class'] });
  }

  /* ── Boot ──────────────────────────────────────────────────────── */
  function start() {
    const host = document.getElementById(HOST_ID);
    if (!host) { setTimeout(start, 200); return; }

    const hostMO = new MutationObserver(() => {
      host.querySelectorAll('iframe').forEach(attachWatcher);
    });
    hostMO.observe(host, { childList: true, subtree: false });

    host.querySelectorAll('iframe').forEach(attachWatcher);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();