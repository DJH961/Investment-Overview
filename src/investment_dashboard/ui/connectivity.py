"""Live connection + navigation feedback for the local desktop app.

The single most common complaint about the local app is that it *feels* stuck:
you click a nav item and nothing visibly happens while the next page builds, and
when the websocket to the local server drops you have no clear signal — you are
just frozen. NiceGUI does detect the drop, but its built-in cue is a tiny popup
in the bottom corner that only fades in after a **2-second delay**
(``#popup[aria-hidden="false"] {{ transition-delay: 2000ms }}`` in
``nicegui.css``), so it is easy to miss entirely.

This module injects a small, framework-independent feedback layer that makes the
app's state continuously visible:

* **Top progress bar** — a thin accent bar that appears the instant you click a
  nav item or a link (and on every page load / unload), so navigation always
  feels responsive even while the server is building the next page synchronously.
* **Connection banner** — a prominent full-width banner ("Connection lost —
  reconnecting…") that appears once a websocket drop *persists* past a short
  grace window, an amber pulse while it retries, and a green "Reconnected" flash
  on recovery. A brief stall (e.g. the server momentarily busy building a heavy
  page) is ridden out behind the calm "Still working…" hint instead of flashing
  an alarming banner. It also exposes a **Reconnect now** escape hatch that first
  tries an *in-place* socket reconnect — preserving the page's state — and only
  falls back to a full reload if the socket stays down, so a wedged tab is never
  a dead end and the button no longer kills a page that is merely busy.
* **Header status dot** — an always-on at-a-glance dot (green connected / amber
  reconnecting / red offline) rendered into the header by :mod:`layout`.
* **Stall hint** — if a load runs unusually long, a small "Still working…" pill
  appears to reassure that the app is busy, not dead.

Everything is driven from the real ``window.socket`` (the socket.io client
NiceGUI creates per page) plus the browser ``online``/``offline`` events, and is
attached additively so it never clobbers NiceGUI's own handlers.

The public surface is intentionally tiny: :func:`install` (called once at boot)
and :data:`HEADER_DOT_HTML` (embedded in the header by :mod:`layout`).
"""

from __future__ import annotations

#: Markup for the always-visible connection dot embedded in the page header.
#: The dot is purely decorative (``aria-hidden``) — status changes are announced
#: to assistive technology via the dedicated ``#inv-a11y-status`` live region in
#: :func:`_body_html`. The class/title are driven from JavaScript in
#: :func:`_script` so the dot stays in lock-step with the live socket state
#: without any server round-trip.
HEADER_DOT_HTML: str = (
    '<span id="inv-conn-dot" class="inv-conn-dot is-ok" '
    'aria-hidden="true" title="Connected"></span>'
)


def _css() -> str:
    """Return the CSS for the progress bar, banner, and header dot."""
    return """
/* ------------------------------------------------------------------ */
/* Connectivity + navigation feedback                                  */
/* ------------------------------------------------------------------ */

/* Hide NiceGUI's default bottom-corner "connection lost" popup — it fades
   in only after a 2s delay and is easy to miss. We replace it with the
   immediate, prominent #inv-connbar below. The too-long-message popup is
   left untouched. */
#popup { display: none !important; }

/* Thin top progress bar shown during navigation / page loads. */
#inv-loadbar {
  position: fixed;
  top: 0;
  left: 0;
  height: 3px;
  width: 0;
  background: linear-gradient(90deg, var(--inv-accent, #2563eb), #7c5cff);
  box-shadow: 0 0 8px rgba(124, 92, 255, .6);
  z-index: 100002;
  opacity: 0;
  transition: width .2s ease, opacity .25s ease;
  pointer-events: none;
}
#inv-loadbar.is-active { opacity: 1; }

/* "Still working…" reassurance shown only when a load runs unusually long. */
#inv-loadhint {
  position: fixed;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  display: none;
  align-items: center;
  gap: .4rem;
  padding: .25rem .7rem;
  font-size: .72rem;
  font-weight: 600;
  color: var(--inv-ink, #1f2937);
  background: var(--inv-surface, #fff);
  border: 1px solid var(--inv-hairline, rgba(0, 0, 0, .12));
  border-radius: 999px;
  box-shadow: var(--inv-shadow-soft, 0 2px 10px rgba(0, 0, 0, .12));
  z-index: 100002;
  pointer-events: none;
}
#inv-loadhint.is-visible { display: flex; }
#inv-loadhint .inv-connbar-spinner {
  width: 11px;
  height: 11px;
  border-color: rgba(0, 0, 0, .2);
  border-top-color: var(--inv-accent, #2563eb);
}

/* Full-width connection banner — appears immediately when the socket drops. */
#inv-connbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  display: none;
  align-items: center;
  justify-content: center;
  gap: .75rem;
  padding: .55rem 1rem;
  font-size: .8rem;
  font-weight: 600;
  color: #1f2937;
  background: #fde68a;            /* amber: reconnecting */
  border-bottom: 1px solid rgba(0, 0, 0, .12);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .12);
  z-index: 100001;
}
#inv-connbar.is-visible { display: flex; }
#inv-connbar.is-offline { background: #fca5a5; }   /* red: browser offline */
#inv-connbar.is-ok { background: #86efac; color: #064e3b; }  /* green: reconnected */

#inv-connbar .inv-connbar-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(0, 0, 0, .25);
  border-top-color: rgba(0, 0, 0, .7);
  border-radius: 50%;
  animation: inv-spin .8s linear infinite;
  flex: 0 0 auto;
}
#inv-connbar.is-ok .inv-connbar-spinner { display: none; }

#inv-connbar .inv-connbar-btn {
  appearance: none;
  border: 1px solid rgba(0, 0, 0, .3);
  background: rgba(255, 255, 255, .55);
  color: inherit;
  font: inherit;
  font-weight: 600;
  padding: .15rem .6rem;
  border-radius: 999px;
  cursor: pointer;
}
#inv-connbar .inv-connbar-btn:hover { background: rgba(255, 255, 255, .85); }
#inv-connbar.is-ok .inv-connbar-btn { display: none; }

@keyframes inv-spin { to { transform: rotate(360deg); } }

/* Visually-hidden live region — announces connection/loading state to screen
   readers (the dot and banner are otherwise silent/decorative). */
.inv-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Always-visible header status dot. */
.inv-conn-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  margin: 0 .35rem;
  background: #22c55e;           /* connected */
  box-shadow: 0 0 0 3px rgba(34, 197, 94, .18);
  vertical-align: middle;
  transition: background .2s ease, box-shadow .2s ease;
}
.inv-conn-dot.is-warn {
  background: #f59e0b;           /* reconnecting */
  box-shadow: 0 0 0 3px rgba(245, 158, 11, .22);
  animation: inv-dot-pulse 1s ease-in-out infinite;
}
.inv-conn-dot.is-bad {
  background: #ef4444;           /* offline / lost */
  box-shadow: 0 0 0 3px rgba(239, 68, 68, .22);
  animation: inv-dot-pulse 1s ease-in-out infinite;
}
@keyframes inv-dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .45; }
}
@media (prefers-reduced-motion: reduce) {
  #inv-loadbar { transition: opacity .25s ease; }
  .inv-conn-dot.is-warn, .inv-conn-dot.is-bad { animation: none; }
  #inv-connbar .inv-connbar-spinner { animation: none; }
}
"""


def _body_html() -> str:
    """Return the banner + progress-bar markup injected into every page body."""
    return """
<div id="inv-loadbar"></div>
<div id="inv-a11y-status" class="inv-sr-only" role="status" aria-live="assertive"></div>
<div id="inv-loadhint">
  <span class="inv-connbar-spinner" aria-hidden="true"></span>
  <span>Still working&hellip;</span>
</div>
<div id="inv-connbar">
  <span class="inv-connbar-spinner" aria-hidden="true"></span>
  <span id="inv-connbar-text">Connection lost &mdash; reconnecting&hellip;</span>
  <button type="button" class="inv-connbar-btn" id="inv-connbar-reload">Reconnect now</button>
</div>
"""


def _script() -> str:
    """Return the client-side controller for the feedback layer.

    Attaches additively to ``window.socket`` (created by NiceGUI in the Vue
    ``mounted`` hook) and to the browser ``online``/``offline`` events. Never
    reassigns ``window.onbeforeunload`` (NiceGUI owns it) — it uses
    ``addEventListener`` so both handlers run.
    """
    return """
<script>
(function () {
  if (window.__invFeedbackInstalled) return;
  window.__invFeedbackInstalled = true;

  // ---- Top progress bar ------------------------------------------------
  var bar = null, hint = null, trickle = null, progress = 0, stallTimer = null;
  function el(id) { return document.getElementById(id); }
  function setText(t) { var n = el('inv-connbar-text'); if (n) n.textContent = t; }
  function showHint(v) {
    hint = hint || el('inv-loadhint');
    if (hint) hint.classList.toggle('is-visible', !!v);
    if (v) announce('Still working\\u2026');
  }
  function announce(msg) {
    var n = el('inv-a11y-status');
    if (n) n.textContent = msg;
  }

  function barStart() {
    bar = bar || el('inv-loadbar');
    if (!bar) return;
    bar.classList.add('is-active');
    progress = Math.max(progress, 8);
    bar.style.width = progress + '%';
    if (trickle) clearInterval(trickle);
    trickle = setInterval(function () {
      // Ease toward 90% so the bar always looks alive but never completes
      // on its own — completion happens on load.
      progress += Math.max(0.4, (90 - progress) * 0.06);
      if (progress > 90) progress = 90;
      if (bar) bar.style.width = progress + '%';
    }, 220);
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(function () {
      // Long load: reassure the user the app is busy, not dead.
      showHint(true);
    }, 8000);
  }
  function barDone() {
    if (trickle) { clearInterval(trickle); trickle = null; }
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    showHint(false);
    bar = bar || el('inv-loadbar');
    if (!bar) return;
    progress = 100;
    bar.style.width = '100%';
    setTimeout(function () {
      if (!bar) return;
      bar.classList.remove('is-active');
      setTimeout(function () { if (bar) { bar.style.width = '0'; progress = 0; } }, 250);
    }, 200);
  }

  // Start as soon as the script runs (the page is still building/hydrating).
  barStart();
  if (document.readyState === 'complete') {
    barDone();
  } else {
    window.addEventListener('load', barDone);
  }

  // Instant feedback the moment the user commits to navigation, before the
  // server round-trip that actually triggers the page change.
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest
      ? e.target.closest('.inv-nav-item, a[href]')
      : null;
    if (t) barStart();
  }, true);
  // The real navigation (NiceGUI does window.open(url, "_self")) fires these.
  window.addEventListener('beforeunload', barStart);
  window.addEventListener('pagehide', barStart);

  // ---- Connection status ----------------------------------------------
  var dot = null, attempts = 0, wasDown = false;
  // A websocket drop is very often just the server briefly busy (e.g. building
  // a heavy page blocks the event loop so it can't answer the heartbeat for a
  // moment). We hold back the alarming banner for a short grace window and show
  // the calm "Still working…" hint instead, escalating only if the drop
  // persists. ``escalated`` tracks whether we actually showed the banner so a
  // sub-second hiccup doesn't flash a scary "lost" → "reconnected" pair.
  var graceTimer = null, lostPending = false, escalated = false;
  var reloadFallbackTimer = null;
  // 4s: long enough to absorb a typical heavy-page build / brief disk stall
  // without flashing a scary banner, but well inside the server's 10s
  // reconnect window so a genuine drop is still surfaced promptly.
  var LOST_GRACE_MS = 4000;
  function setDot(cls, title) {
    dot = dot || el('inv-conn-dot');
    if (!dot) return;
    dot.classList.remove('is-ok', 'is-warn', 'is-bad');
    dot.classList.add(cls);
    dot.title = title;
  }
  function showBar(stateClass, text) {
    var b = el('inv-connbar');
    if (!b) return;
    b.classList.remove('is-offline', 'is-ok');
    if (stateClass) b.classList.add(stateClass);
    b.classList.add('is-visible');
    setText(text);
    announce(text);
  }
  function hideBar() {
    var b = el('inv-connbar');
    if (b) b.classList.remove('is-visible', 'is-offline', 'is-ok');
  }

  // Called from the server when the user chooses to shut the app down. The
  // websocket is *about* to drop on purpose, so suppress the alarming
  // "connection lost" banner, show a calm confirmation instead, and try to
  // auto-close the tab (works when the app opened it, e.g. native/show=True).
  window.__invBeginShutdown = function () {
    window.__invShuttingDown = true;
    setDot('is-ok', 'Shutting down\\u2026');
    var b = el('inv-connbar');
    if (b) {
      b.classList.remove('is-offline');
      b.classList.add('is-visible', 'is-ok');
      setText('Shutting down\\u2026 you can close this tab.');
      var btn = el('inv-connbar-reload');
      if (btn) btn.style.display = 'none';
    }
    try { window.close(); } catch (e) { /* browser refused — message stays */ }
  };

  function onLost(offline) {
    if (window.__invShuttingDown) return;
    wasDown = true;
    if (offline) {
      // A real browser-level network drop — show immediately, no grace.
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      lostPending = false;
      showHint(false);
      escalateLost(true);
      return;
    }
    // Websocket hiccup: stay calm during the grace window, then escalate only
    // if it is still down. Keeps a momentary stall during a load from flashing
    // a scary "connection lost" banner.
    setDot('is-warn', 'Reconnecting\\u2026');
    showHint(true);
    if (lostPending) return;
    lostPending = true;
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(function () {
      graceTimer = null;
      lostPending = false;
      if (wasDown && (!window.socket || !window.socket.connected)) {
        showHint(false);
        escalateLost(false);
      }
    }, LOST_GRACE_MS);
  }
  function escalateLost(offline) {
    if (window.__invShuttingDown) return;
    escalated = true;
    if (offline) {
      setDot('is-bad', 'Offline — no network');
      showBar('is-offline', 'You are offline \\u2014 check your connection\\u2026');
    } else {
      setDot('is-warn', 'Reconnecting\\u2026');
      showBar('', 'Connection lost \\u2014 reconnecting'
        + (attempts ? ' (attempt ' + attempts + ')' : '') + '\\u2026');
    }
  }
  function onReconnectAttempt(n) {
    if (window.__invShuttingDown) return;
    attempts = n || (attempts + 1);
    setDot('is-warn', 'Reconnecting\\u2026');
    // Only refresh the banner text once we've actually escalated; during the
    // grace window we stay quiet behind the "Still working…" hint.
    if (escalated) escalateLost(!navigator.onLine);
  }
  function onUp() {
    attempts = 0;
    lostPending = false;
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    if (reloadFallbackTimer) { clearTimeout(reloadFallbackTimer); reloadFallbackTimer = null; }
    showHint(false);
    setDot('is-ok', 'Connected');
    barDone();
    if (wasDown && escalated) {
      // Only celebrate recovery if we actually warned about a loss; a hiccup
      // that never escalated should resolve silently.
      showBar('is-ok', 'Reconnected');
      setTimeout(hideBar, 1800);
    } else {
      hideBar();
    }
    wasDown = false;
    escalated = false;
  }

  var reloadBtn = el('inv-connbar-reload');
  if (reloadBtn) reloadBtn.addEventListener('click', function () {
    var s = window.socket;
    // Prefer an in-place socket reconnect: it rides out a server stall and
    // resumes with the page state intact. A full reload, by contrast, asks the
    // (often still-busy) server for a brand-new page and frequently wedges the
    // tab — that is the "reconnect button kills the page" symptom. We only fall
    // back to a destructive reload if the socket is still down after a grace.
    if (s && typeof s.connect === 'function') {
      setText('Reconnecting\\u2026');
      try { s.connect(); } catch (e) { /* ignore */ }
      if (s.io && typeof s.io.reconnect === 'function') {
        try { s.io.reconnect(); } catch (e) { /* ignore */ }
      }
      if (reloadFallbackTimer) clearTimeout(reloadFallbackTimer);
      reloadFallbackTimer = setTimeout(function () {
        reloadFallbackTimer = null;
        if (!window.socket || !window.socket.connected) {
          setText('Reloading\\u2026');
          window.location.reload();
        }
      }, 5000);
      return;
    }
    // No socket to revive — a reload is the only way back.
    setText('Reloading\\u2026');
    window.location.reload();
  });

  // Browser-level connectivity (covers Wi-Fi drops the socket is slow to notice).
  window.addEventListener('offline', function () { onLost(true); });
  window.addEventListener('online', function () {
    // Don't claim "connected" until the websocket itself is back.
    if (window.socket && window.socket.connected) onUp();
    else { setDot('is-warn', 'Reconnecting\\u2026'); }
  });

  // Attach to the socket.io client once NiceGUI has created it.
  var waitForSocket = setInterval(function () {
    var s = window.socket;
    if (!s) return;
    clearInterval(waitForSocket);
    s.on('disconnect', function () { onLost(!navigator.onLine); });
    s.on('connect', onUp);
    if (s.io && s.io.on) {
      s.io.on('reconnect_attempt', onReconnectAttempt);
      s.io.on('reconnect', onUp);
      s.io.on('reconnect_error', function () { onLost(!navigator.onLine); });
    }
    if (s.connected) setDot('is-ok', 'Connected');
  }, 150);
})();
</script>
"""


def install() -> None:
    """Inject the feedback CSS, markup, and controller into every page.

    Idempotent at the browser level (the script guards with
    ``window.__invFeedbackInstalled``). Call once at boot, alongside
    :func:`investment_dashboard.ui.style.install`.
    """
    from nicegui import ui  # noqa: PLC0415 - lazy (needs a NiceGUI context)

    # ``shared=True`` so the snippets attach to every ``@ui.page`` client, not
    # just the auto-index page (mirrors ui.style.install's requirement).
    ui.add_head_html(f"<style>{_css()}</style>", shared=True)
    ui.add_body_html(_body_html() + _script(), shared=True)
