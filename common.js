/* ============================================================
   common.js  —  shared foundation for every page

   Holds the things every page repeated: the Supabase connection,
   the login (auth) gate, request helpers, and formatters.
   Change any of these once here, and every page gets it.

   Requires the Supabase library to be loaded first:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="common.js"></script>

   Usage on a page:
     App.requireLogin(function () {
        // runs only once the user is signed in; load your data here
     });
   ============================================================ */
(function (global) {
  'use strict';

  const SUPABASE_URL = "https://yavfcitgyyftpubqwddp.supabase.co";
  const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhdmZjaXRneXlmdHB1YnF3ZGRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNzkwNTgsImV4cCI6MjA5NDg1NTA1OH0.sK7t0YkJlPL6_WlFHfX8JYyw4zB_nAU5iBFL07LdW9Y";

  let authToken = null;
  const sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // ---- request helpers (use the logged-in token once available) ----
  function getHeaders() {
    return { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + (authToken || SUPABASE_KEY), "Content-Type": "application/json" };
  }
  async function rest(path) {
    const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, { headers: getHeaders() });
    if (!r.ok) throw new Error(path + " -> " + r.status);
    return r.json();
  }
  async function rpc(name, body) {
    const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, { method: "POST", headers: getHeaders(), body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error("rpc " + name + " -> " + r.status);
    return r.json();
  }
  async function write(method, path, payload) {
    const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, { method: method, headers: Object.assign(getHeaders(), { Prefer: "return=minimal" }), body: JSON.stringify(payload) });
    if (!r.ok) {
      let detail = "";
      try { const body = await r.json(); detail = body.message || body.hint || body.details || JSON.stringify(body); } catch (e) { try { detail = await r.text(); } catch (e2) {} }
      throw new Error(method + " " + path + " -> " + r.status + (detail ? " | " + detail : ""));
    }
    return true;
  }

  // ---- formatters ----
  const fmt = (n) => "£" + Math.round(n || 0).toLocaleString("en-GB");
  const fmtDiff = (n) => (n >= 0 ? "+" : "−") + "£" + Math.abs(Math.round(n)).toLocaleString("en-GB");
  const parseLocalDate = (s) => { if (!s) return null; const p = String(s).split('T')[0].split('-'); return p.length < 3 ? null : new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); };
  const toInputDate = (d) => { if (!d) return ""; if (typeof d === 'string') { const p = d.split('T')[0]; return p; } return d.getFullYear() + '-' + ("0" + (d.getMonth() + 1)).slice(-2) + '-' + ("0" + d.getDate()).slice(-2); };

  // ---- login (auth) gate ----
  // Injects a login overlay if the page doesn't already have one, then
  // calls onReady(session) once the user is signed in (now or already).
  const OVERLAY_HTML =
    '<div id="loginOverlay" style="position:fixed;inset:0;background:#f4f7f6;display:flex;align-items:center;justify-content:center;z-index:2000;font-family:\'Segoe UI\',Tahoma,sans-serif;">' +
      '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:30px;width:100%;max-width:360px;box-shadow:0 4px 16px rgba(0,0,0,0.08);">' +
        '<h2 id="loginTitle" style="margin:0 0 6px;color:#2c3e50;">Sign in</h2>' +
        '<p style="font-size:13px;color:#64748b;margin:0 0 20px;">Please sign in to view your data.</p>' +
        '<label style="display:block;font-weight:bold;font-size:13px;color:#2c3e50;margin-bottom:5px;">Email</label>' +
        '<input type="email" id="cmnEmail" autocomplete="username" inputmode="email" style="width:100%;padding:11px;border:1px solid #ccc;border-radius:6px;font-size:15px;box-sizing:border-box;margin-bottom:16px;">' +
        '<label style="display:block;font-weight:bold;font-size:13px;color:#2c3e50;margin-bottom:5px;">Password</label>' +
        '<input type="password" id="cmnPass" autocomplete="current-password" style="width:100%;padding:11px;border:1px solid #ccc;border-radius:6px;font-size:15px;box-sizing:border-box;margin-bottom:16px;">' +
        '<button id="cmnBtn" style="width:100%;background:#3498db;color:#fff;border:none;padding:12px;border-radius:6px;font-weight:bold;font-size:15px;cursor:pointer;">Sign in</button>' +
        '<div id="cmnErr" style="color:#c0392b;font-size:13px;font-weight:bold;margin-top:14px;min-height:18px;"></div>' +
      '</div>' +
    '</div>';

  let onReadyCb = null;
  let started = false;

  function showOverlay(show) {
    const o = document.getElementById('loginOverlay');
    if (o) o.style.display = show ? 'flex' : 'none';
  }

  function begin(session) {
    authToken = session.access_token;
    showOverlay(false);
    const w = document.getElementById('whoami');
    if (w) w.textContent = 'Signed in as ' + (session.user && session.user.email ? session.user.email : '');
    if (!started) { started = true; startIdleWatch(); if (onReadyCb) onReadyCb(session); }
  }

  async function doLogin() {
    const btn = document.getElementById('cmnBtn');
    const err = document.getElementById('cmnErr');
    err.textContent = '';
    const email = (document.getElementById('cmnEmail').value || '').trim();
    const password = document.getElementById('cmnPass').value || '';
    if (!email || !password) { err.textContent = 'Enter your email and password.'; return; }
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const res = await sb.auth.signInWithPassword({ email: email, password: password });
      if (res.error) throw res.error;
      begin(res.data.session);
    } catch (e) {
      err.textContent = (e && e.message) ? e.message : 'Sign in failed.';
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  }

  async function doLogout() { await sb.auth.signOut(); location.reload(); }

  // ---- inactivity auto-logout (15 min, with a 1 min warning) ----
  const IDLE_MS = 15 * 60 * 1000;   // sign out after this long with no activity
  const WARN_MS = 14 * 60 * 1000;   // show warning 1 minute before
  let idleTimer = null, warnTimer = null, countdownTimer = null;

  function removeIdleWarning() {
    const w = document.getElementById('idleWarn');
    if (w) w.parentNode.removeChild(w);
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  function showIdleWarning() {
    if (document.getElementById('idleWarn')) return;
    let secs = Math.round((IDLE_MS - WARN_MS) / 1000);
    const html =
      '<div id="idleWarn" style="position:fixed;left:0;right:0;bottom:0;z-index:3000;background:#fef3c7;border-top:2px solid #fcd34d;color:#92400e;padding:12px 16px;font-family:\'Segoe UI\',Tahoma,sans-serif;display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;">' +
        '<span style="font-weight:bold;">You\'ll be signed out in <span id="idleSecs">' + secs + '</span>s due to inactivity.</span>' +
        '<button id="idleStay" style="background:#3498db;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:bold;cursor:pointer;">Stay signed in</button>' +
      '</div>';
    document.body.insertAdjacentHTML('beforeend', html);
    document.getElementById('idleStay').addEventListener('click', bumpActivity);
    countdownTimer = setInterval(function () {
      secs -= 1;
      const el = document.getElementById('idleSecs');
      if (el) el.textContent = Math.max(0, secs);
    }, 1000);
  }

  async function idleLogout() {
    removeIdleWarning();
    try { await sb.auth.signOut(); } catch (e) {}
    location.reload();
  }

  function bumpActivity() {
    if (!started) return;            // only run once signed in
    removeIdleWarning();
    if (warnTimer) clearTimeout(warnTimer);
    if (idleTimer) clearTimeout(idleTimer);
    warnTimer = setTimeout(showIdleWarning, WARN_MS);
    idleTimer = setTimeout(idleLogout, IDLE_MS);
  }

  function startIdleWatch() {
    ['click', 'keydown', 'mousemove', 'scroll', 'touchstart', 'touchmove'].forEach(function (ev) {
      window.addEventListener(ev, onLocalActivity, { passive: true });
    });
    // If we're embedded in a parent (iframe), tell the parent we're active too.
    // If we're the parent, accept activity pings from our frames.
    window.addEventListener('message', function (e) {
      if (e && e.data === 'app-activity') bumpActivity();
    });
    bumpActivity(); // start the clock
  }

  function onLocalActivity() {
    bumpActivity();
    // notify parent (no-op if we're not embedded)
    try { if (window.parent && window.parent !== window) window.parent.postMessage('app-activity', '*'); } catch (e) {}
  }

  function requireLogin(onReady, opts) {
    onReadyCb = onReady;
    // inject overlay if the page hasn't supplied its own
    if (!document.getElementById('loginOverlay')) {
      document.body.insertAdjacentHTML('afterbegin', OVERLAY_HTML);
      if (opts && opts.title) { const t = document.getElementById('loginTitle'); if (t) t.textContent = opts.title; }
    }
    const btn = document.getElementById('cmnBtn');
    if (btn) btn.addEventListener('click', doLogin);
    const pass = document.getElementById('cmnPass');
    if (pass) pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    // resume an existing session (shared across all pages on this site)
    sb.auth.getSession().then((r) => { if (r && r.data && r.data.session) begin(r.data.session); });
  }

  global.App = {
    sb: sb,
    getHeaders: getHeaders,
    rest: rest, rpc: rpc, write: write,
    fmt: fmt, fmtDiff: fmtDiff, parseLocalDate: parseLocalDate, toInputDate: toInputDate,
    requireLogin: requireLogin, doLogin: doLogin, doLogout: doLogout,
    token: () => authToken
  };

})(window);
