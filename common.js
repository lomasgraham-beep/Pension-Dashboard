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

  // Keep our token copy in step with the library's background refreshes.
  // Supabase silently issues a new access token roughly hourly; without this,
  // requests would keep using the original (now expired) snapshot and get 401s.
  sb.auth.onAuthStateChange(function (_event, session) {
    if (session && session.access_token) authToken = session.access_token;
  });

  // Force a fresh token, used to self-heal a 401 (e.g. after an iPad tab was
  // frozen in the background and its refresh timer paused). Tries an explicit
  // refresh first, then falls back to whatever session is currently stored.
  async function refreshToken() {
    try {
      const r = await sb.auth.refreshSession();
      if (r && r.data && r.data.session && r.data.session.access_token) { authToken = r.data.session.access_token; return authToken; }
    } catch (e) {}
    try {
      const r = await sb.auth.getSession();
      if (r && r.data && r.data.session && r.data.session.access_token) { authToken = r.data.session.access_token; return authToken; }
    } catch (e) {}
    return authToken;
  }

  // ---- request helpers (use the logged-in token once available) ----
  function getHeaders() {
    return { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + (authToken || SUPABASE_KEY), "Content-Type": "application/json" };
  }
  // cache:'no-store' is essential. Without it Safari happily serves a previously fetched GET for
  // the same URL, so re-running a page's load() returns identical bytes and an in-page refresh
  // appears to do nothing. Only a full browser reload broke through. PostgREST reads are cheap;
  // always going to the network is the right trade.
  async function rest(path) {
    const url = SUPABASE_URL + "/rest/v1/" + path;
    let r = await fetch(url, { headers: getHeaders(), cache: 'no-store' });
    if (r.status === 401) { await refreshToken(); r = await fetch(url, { headers: getHeaders(), cache: 'no-store' }); }
    if (!r.ok) throw new Error(path + " -> " + r.status);
    return r.json();
  }
  async function rpc(name, body) {
    const url = SUPABASE_URL + "/rest/v1/rpc/" + name;
    const payload = JSON.stringify(body || {});
    let r = await fetch(url, { method: "POST", headers: getHeaders(), body: payload });
    if (r.status === 401) { await refreshToken(); r = await fetch(url, { method: "POST", headers: getHeaders(), body: payload }); }
    if (!r.ok) throw new Error("rpc " + name + " -> " + r.status);
    return r.json();
  }
  async function write(method, path, payload) {
    const url = SUPABASE_URL + "/rest/v1/" + path;
    const body = JSON.stringify(payload);
    const opts = function () { return { method: method, headers: Object.assign(getHeaders(), { Prefer: "return=minimal" }), body: body }; };
    let r = await fetch(url, opts());
    if (r.status === 401) { await refreshToken(); r = await fetch(url, opts()); }
    if (!r.ok) {
      let detail = "";
      try { const eb = await r.json(); detail = eb.message || eb.hint || eb.details || JSON.stringify(eb); } catch (e) { try { detail = await r.text(); } catch (e2) {} }
      throw new Error(method + " " + path + " -> " + r.status + (detail ? " | " + detail : ""));
    }
    return true;
  }

  // ---- member names (alphabetical; matches the engine's person1/person2 rule) ----
  // Returns { p1, p2, all }. p2 is null for a single-member (single-person) instance.
  let _memberCache = null;
  async function memberNames(force) {
    if (_memberCache && !force) return _memberCache;
    let rows = [];
    try { rows = await rest("bd_members"); } catch (e) { rows = []; }
    const sorted = (rows || []).slice().sort(function (a, b) { return String(a.name || "").localeCompare(String(b.name || "")); });
    const all = sorted.map(function (m) { return m.name; }).filter(Boolean);
    _memberCache = { p1: all[0] || null, p2: all[1] || null, all: all };
    return _memberCache;
  }

  // ---- formatters ----
  const fmt = (n) => "£" + Math.round(n || 0).toLocaleString("en-GB");
  const fmtDiff = (n) => (n >= 0 ? "+" : "−") + "£" + Math.abs(Math.round(n)).toLocaleString("en-GB");
  const parseLocalDate = (s) => { if (!s) return null; const p = String(s).split('T')[0].split('-'); return p.length < 3 ? null : new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); };
  const toInputDate = (d) => { if (!d) return ""; if (typeof d === 'string') { const p = d.split('T')[0]; return p; } return d.getFullYear() + '-' + ("0" + (d.getMonth() + 1)).slice(-2) + '-' + ("0" + d.getDate()).slice(-2); };

  // ---- holiday costing (shared single source of truth) ----
  // Every engine-feed site and the planner page use these, so the annual figure
  // is always computed the same way and never goes stale when a price/rate changes.
  //
  //   holidayCtx(costRows, mealRows, settings)  -> a reusable lookup context
  //   holidayWeekBreakdown(week, ctx)           -> { accom, fuel, incidentals, eat, total }
  //   holidayWeekTotal(week, ctx)               -> number (the week's total cost)
  //   holidayAnnual(planRows, ctx, phase)       -> Σ of week totals for that phase
  //
  // Fuel: miles ÷ mpg = UK gallons; × 4.54609 = litres; × £/litre = fuel cost.
  // Towing uses the towing mpg. Eating-out is a meal×night grid looked up from meal costs.
  const LITRES_PER_UK_GALLON = 4.54609;
  const HOLIDAY_MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Drinks'];

  function holidayCtx(costRows, mealRows, settings) {
    const costMap = {};   // "Category|Level" -> per-night cost
    (costRows || []).forEach(function (c) { costMap[c.category + '|' + c.level] = Number(c.cost) || 0; });
    const mealMap = {};   // "Meal|Level" -> cost
    (mealRows || []).forEach(function (m) { mealMap[m.meal_type + '|' + m.level] = Number(m.cost) || 0; });
    const s = settings || {};
    return {
      costMap: costMap, mealMap: mealMap,
      pricePerLitre: Number(s.price_per_litre) || 0,
      mpgNormal: Number(s.mpg_normal) || 0,
      mpgTowing: Number(s.mpg_towing) || 0
    };
  }

  // eating_out may arrive as a jsonb object (PostgREST) or a JSON string; normalise to an object.
  function parseGrid(g) {
    if (!g) return {};
    if (typeof g === 'string') { try { return JSON.parse(g) || {}; } catch (e) { return {}; } }
    return g;
  }

  function holidayWeekBreakdown(week, ctx) {
    const nights = Number(week.nights) || 0;
    // accommodation: per-night price × nights
    let accom = 0;
    if (week.category && week.level) accom = (ctx.costMap[week.category + '|' + week.level] || 0) * nights;
    // fuel: REMOVED at the ann11 split — fuel is now its own term (see the fuel section below)
    // and is planned per week on bd_fuel_line, not from bd_holiday_plan.miles/towing.
    // The key is retained and forced to 0 so any page still reading b.fuel shows nothing
    // rather than throwing; those readers are being removed in the same rollout.
    const fuel = 0;
    // incidentals
    const incidentals = Number(week.incidentals) || 0;
    // eating out: sum every filled cell in the meal×night grid
    let eat = 0;
    const grid = parseGrid(week.eating_out);
    HOLIDAY_MEALS.forEach(function (meal) {
      const arr = grid[meal];
      if (!Array.isArray(arr)) return;
      arr.forEach(function (lvl) { if (lvl) eat += (ctx.mealMap[meal + '|' + lvl] || 0); });
    });
    return { accom: accom, fuel: fuel, incidentals: incidentals, eat: eat, total: accom + fuel + incidentals + eat };
  }

  function holidayWeekTotal(week, ctx) { return holidayWeekBreakdown(week, ctx).total; }

  function holidayAnnual(planRows, ctx, phase) {
    const want = phase || 'retired';
    let total = 0;
    (planRows || []).forEach(function (w) {
      if ((w.phase || 'retired') !== want) return;
      total += holidayWeekTotal(w, ctx);
    });
    return Math.round(total * 100) / 100;
  }

  // ---- fuel costing (build ann11 split) ----
  // Fuel used to be folded into the holiday week total. It is now planned independently on
  // bd_fuel_line and costed here, because fuel is two different kinds of spend:
  //
  //   purpose 'Work'  -> commuting. A fixed cost that ENDS on a date; never tapered, never
  //                      touched by the spending slider.
  //   everything else -> discretionary driving (Holiday / Caravan / Out and about), which
  //                      behaves exactly like dining and holidays.
  //
  // STANDING LINES AND DETACHMENT
  // A row with week_no === null is a STANDING line: it applies to all 52 weeks (the weekly
  // commute, keyed once). A row for a specific week carrying standing_id = <that standing row's
  // id> DETACHES it for that week only — the week's row replaces it outright. So a holiday week
  // with no commute is a detach row with miles 0, and later edits to the standing definition
  // leave already-detached weeks alone.
  const FUEL_PURPOSES = ['Work', 'Holiday', 'Caravan', 'Out and about'];
  const FUEL_WORK = 'Work';

  function fuelCtx(settingsRow) {
    const s = settingsRow || {};
    return {
      pricePerLitre: Number(s.price_per_litre) || 0,
      mpgNormal: Number(s.mpg_normal) || 0,
      mpgTowing: Number(s.mpg_towing) || 0,
      taper: { taper_at_70: s.taper_at_70, taper_at_80: s.taper_at_80, taper_at_90: s.taper_at_90 },
      workEndsOn: s.work_ends_on || null
    };
  }

  // miles ÷ MPG = UK gallons; × 4.54609 = litres; × £/litre. Towing switches to the towing MPG.
  function fuelLineCost(line, ctx) {
    const miles = Number(line && line.miles) || 0;
    const mpg = (line && line.towing) ? ctx.mpgTowing : ctx.mpgNormal;
    if (miles <= 0 || mpg <= 0 || ctx.pricePerLitre <= 0) return 0;
    return (miles / mpg) * LITRES_PER_UK_GALLON * ctx.pricePerLitre;
  }

  // The lines that actually apply to one week: standing lines minus any this week has detached,
  // plus the week's own rows. `inherited` tells the UI to render it greyed and read-only-ish.
  function fuelWeekLines(allLines, weekNo) {
    const rows = allLines || [];
    const detached = {};
    rows.forEach(function (l) {
      if (l.week_no != null && Number(l.week_no) === Number(weekNo) && l.standing_id != null) {
        detached[l.standing_id] = true;
      }
    });
    const out = [];
    rows.forEach(function (l) {
      if (l.week_no == null && !detached[l.id]) {
        out.push({ id: l.id, purpose: l.purpose, miles: l.miles, towing: l.towing,
                   sort_order: l.sort_order, inherited: true, standing_id: l.id });
      }
    });
    rows.forEach(function (l) {
      if (l.week_no != null && Number(l.week_no) === Number(weekNo)) {
        out.push({ id: l.id, purpose: l.purpose, miles: l.miles, towing: l.towing,
                   sort_order: l.sort_order, inherited: false, standing_id: l.standing_id });
      }
    });
    out.sort(function (a, b) { return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0); });
    return out;
  }

  // One week, split the way the engine wants it.
  function fuelWeekBreakdown(allLines, weekNo, ctx) {
    let work = 0, disc = 0;
    fuelWeekLines(allLines, weekNo).forEach(function (l) {
      const c = fuelLineCost(l, ctx);
      if (l.purpose === FUEL_WORK) work += c; else disc += c;
    });
    return { work: work, disc: disc, total: work + disc };
  }

  function fuelWeekTotal(allLines, weekNo, ctx) { return fuelWeekBreakdown(allLines, weekNo, ctx).total; }

  // Σ over all 52 weeks -> { workAnnual, discAnnual, total }. These map straight onto the engine's
  // data.fuelWorkAnnual / data.fuelAnnual.
  function fuelAnnual(allLines, ctx) {
    let work = 0, disc = 0;
    for (let w = 1; w <= 52; w++) {
      const b = fuelWeekBreakdown(allLines, w, ctx);
      work += b.work; disc += b.disc;
    }
    return {
      workAnnual: Math.round(work * 100) / 100,
      discAnnual: Math.round(disc * 100) / 100,
      total: Math.round((work + disc) * 100) / 100
    };
  }

  // One call for every page that feeds the engine: fetches the fuel settings and lines and returns
  // the plan figures, the taper and the work end date in the shape the engine wants. Degrades to
  // zeros on any error, so a page that loads before the fuel tables exist still renders — and with
  // zeros the engine's fuel term stays inert, exactly as it was before the ann11 split.
  async function loadFuelForEngine() {
    try {
      const res = await Promise.all([
        rest('bd_fuel_settings?id=eq.1'),
        rest('bd_fuel_line?phase=eq.retired&order=sort_order.asc')
      ]);
      const c = fuelCtx((res[0] && res[0][0]) || {});
      const a = fuelAnnual(res[1] || [], c);
      return { ctx: c, planWork: a.workAnnual, planDisc: a.discAnnual, planTotal: a.total,
               taper: c.taper, workEndsOn: c.workEndsOn };
    } catch (e) {
      return { ctx: fuelCtx({}), planWork: 0, planDisc: 0, planTotal: 0, taper: {}, workEndsOn: null, degraded: true };
    }
  }

  // ---- discretionary basis: Plan vs Actual last-12-months (shared) ----
  // ONE saved choice governs the dining & holiday annual figures handed to the
  // budget, the bills page and the whole modelling engine, so every surface agrees.
  //
  //   basis 'plan'   -> the planned figures (dining rota / holiday plan). This is
  //                     today's behaviour, reproduced byte-for-byte: resolveDiscretionary
  //                     just returns the plan numbers the caller already computed.
  //   basis 'actual' -> the trailing-12-month spend on the card categories named
  //                     "Dining" / "Holidays", each ± a saved MONTHLY adjustment
  //                     (annualised ×12). Reimburse is excluded, matching Cost Analysis.
  //
  // Persisted in bd_discretionary_basis (single row, id=1) so the choice and the two
  // adjustments follow the user to any device. Category resolution is by name so a
  // rename of the category is picked up automatically; no code list is stored.
  const DISCRETIONARY_DEFAULT = { basis: 'plan', dining_adjust: 0, holiday_adjust: 0, fuel_adjust: 0 };
  let _discSettingsCache = null;

  // Drops the session-lifetime caches so the next read goes to the database. Call before a manual
  // in-page refresh: _discSettingsCache otherwise survives for the life of the tab, so a changed
  // Plan/Actual basis or adjustment would never show up without a full reload.
  function clearCaches() { _discSettingsCache = null; _catBasisCache = null; _actualCache = null; }

  async function loadDiscretionaryBasis(force) {
    if (_discSettingsCache && !force) return _discSettingsCache;
    let out = Object.assign({}, DISCRETIONARY_DEFAULT);
    try {
      const rows = await rest('bd_discretionary_basis?id=eq.1');
      const r = (rows && rows[0]) || {};
      out = {
        basis: (r.basis === 'actual' || r.basis === 'mixed') ? r.basis : 'plan',
        dining_adjust: Number(r.dining_adjust) || 0,
        holiday_adjust: Number(r.holiday_adjust) || 0,
        fuel_adjust: Number(r.fuel_adjust) || 0
      };
    } catch (e) { /* table missing or unreadable -> safe default (plan) */ }
    _discSettingsCache = out;
    return out;
  }

  async function saveDiscretionaryBasis(s) {
    const payload = {
      basis: (s && (s.basis === 'actual' || s.basis === 'mixed')) ? s.basis : 'plan',
      dining_adjust: Number(s && s.dining_adjust) || 0,
      holiday_adjust: Number(s && s.holiday_adjust) || 0,
      fuel_adjust: Number(s && s.fuel_adjust) || 0,
      updated_at: new Date().toISOString()
    };
    await write('PATCH', 'bd_discretionary_basis?id=eq.1', payload);
    _discSettingsCache = { basis: payload.basis, dining_adjust: payload.dining_adjust, holiday_adjust: payload.holiday_adjust, fuel_adjust: payload.fuel_adjust };
    _catBasisCache = null; _actualCache = null;   // basis changed -> per-category view is stale
    return _discSettingsCache;
  }

  // Resolve which bd_bill_category codes are the Dining / Holidays (and Reimburse)
  // buckets, by name (description first, then code), case-insensitive.
  function discretionaryCodeSets(catRows) {
    const dining = {}, holiday = {}, reimburse = {}, fuel = {};
    (catRows || []).forEach(function (c) {
      const nm = String(c.description || '').trim().toLowerCase();
      const cd = String(c.code || '').trim().toLowerCase();
      if (nm === 'dining' || cd === 'dining') dining[c.code] = true;
      if (nm === 'holiday' || nm === 'holidays' || cd === 'holiday' || cd === 'holidays') holiday[c.code] = true;
      if (nm === 'reimburse' || cd === 'reimburse') reimburse[c.code] = true;
      if (nm === 'fuel' || nm === 'petrol' || nm === 'diesel' || cd === 'fuel') fuel[c.code] = true;
    });
    return { dining: dining, holiday: holiday, reimburse: reimburse, fuel: fuel };
  }

  // ---- Trailing-12-month actual card spend, PER CATEGORY -------------------------------
  // Window = the 12 calendar months ending at the most recent txn month present (mirrors Cost
  // Analysis' rolling year). Net of refunds (negative amounts). Reimburse-coded rows are excluded
  // entirely — they are money coming back, not a category of spend.
  // Returns { byCode: { code -> { total, count } }, endMonth, months }. `count` exists so the
  // Bills Category page can show coverage: a flagged category with 0 txns is the silent-zero trap.
  function actualByCategory12mo(txns, catRows) {
    const sets = discretionaryCodeSets(catRows);
    const present = {};
    (txns || []).forEach(function (t) { const ym = String(t.txn_date || '').slice(0, 7); if (ym) present[ym] = true; });
    const keys = Object.keys(present).sort();
    if (!keys.length) return { byCode: {}, endMonth: null, months: 12 };
    const end = keys[keys.length - 1];
    const ey = Number(end.slice(0, 4)), em = Number(end.slice(5, 7));
    const wanted = {};
    for (let i = 11; i >= 0; i--) { let mm = em - i, yy = ey; while (mm <= 0) { mm += 12; yy -= 1; } wanted[yy + '-' + ('0' + mm).slice(-2)] = true; }
    const byCode = {};
    (txns || []).forEach(function (t) {
      const ym = String(t.txn_date || '').slice(0, 7);
      if (!wanted[ym]) return;
      const code = t.category_code;
      if (!code || sets.reimburse[code]) return;
      const e = byCode[code] || (byCode[code] = { total: 0, count: 0 });
      e.total += Number(t.amount) || 0; e.count += 1;
    });
    Object.keys(byCode).forEach(function (k) { byCode[k].total = Math.round(byCode[k].total * 100) / 100; });
    return { byCode: byCode, endMonth: end, months: 12 };
  }
  // sum the 12-month actual across every code in a set (dining / holiday / fuel are each one code
  // in practice, but the sets allow synonyms so this stays correct if you add one)
  function sumSet(byCode, set) {
    let t = 0;
    Object.keys(set || {}).forEach(function (c) { if (byCode[c]) t += byCode[c].total; });
    return Math.round(t * 100) / 100;
  }
  // Back-compat shape used by the old three-domain callers.
  function actualDiscretionary12mo(txns, catRows) {
    const sets = discretionaryCodeSets(catRows);
    const a = actualByCategory12mo(txns, catRows);
    return { diningTotal: sumSet(a.byCode, sets.dining), holidayTotal: sumSet(a.byCode, sets.holiday),
             fuelTotal: sumSet(a.byCode, sets.fuel), endMonth: a.endMonth, months: 12 };
  }

  // ---- Per-category basis (Plan / Actual / Mixed) ---------------------------------------
  // basis 'plan'   -> nothing uses actuals, whatever the flags say
  // basis 'actual' -> everything uses actuals, whatever the flags say (kept so you keep the
  //                   one-tap whole-model comparison)
  // basis 'mixed'  -> each category follows its own use_actual flag on bd_bill_category
  //
  // If the use_actual / actual_adjust columns do not exist yet the select fails, cats stays empty,
  // and every category resolves to plan under 'mixed' — i.e. the app degrades to today's behaviour
  // rather than erroring.
  let _catBasisCache = null;
  let _actualCache = null;

  async function loadCategoryBasis(force) {
    if (_catBasisCache && !force) return _catBasisCache;
    let basis = 'plan';
    const cats = {};
    try {
      const rows = await rest('bd_discretionary_basis?id=eq.1');
      const r = (rows && rows[0]) || {};
      basis = (r.basis === 'actual' || r.basis === 'mixed') ? r.basis : 'plan';
    } catch (e) { /* unreadable -> plan */ }
    try {
      const cr = await rest('bd_bill_category?select=code,description,use_actual,actual_adjust');
      (cr || []).forEach(function (c) {
        if (c.code == null) return;
        cats[c.code] = { code: c.code, description: c.description,
                         use_actual: c.use_actual === true,
                         actual_adjust: Number(c.actual_adjust) || 0 };
      });
    } catch (e) { /* columns missing -> every category stays on plan under 'mixed' */ }
    _catBasisCache = { basis: basis, cats: cats };
    return _catBasisCache;
  }

  function categoryUsesActual(code, s) {
    if (!s || s.basis === 'plan') return false;
    if (s.basis === 'actual') return true;
    const c = s.cats && s.cats[code];
    return !!(c && c.use_actual);
  }
  // Bill-backed categories follow their OWN FLAG ONLY, never the global 'actual'.
  // The global switch has always meant "the three planner domains on actuals"; letting it also
  // sweep every bill category would zero out every bill in a category with no card spend the
  // instant you tapped Actual (council tax, mortgage, anything on direct debit). So:
  //   plan   -> nothing
  //   actual -> planner domains forced on; bill categories follow their flags
  //   mixed  -> everything follows its flag
  function categoryFlagged(code, s) {
    if (!s || s.basis === 'plan') return false;
    const c = s.cats && s.cats[code];
    return !!(c && c.use_actual);
  }
  function categoryAdjust(code, s) {
    const c = s && s.cats && s.cats[code];
    return c ? (Number(c.actual_adjust) || 0) : 0;
  }
  // a whole domain (dining / holiday / fuel) is on actuals if ANY of its codes is
  function setUsesActual(set, s) {
    if (!s || s.basis === 'plan') return false;
    if (s.basis === 'actual') return true;
    return Object.keys(set || {}).some(function (c) { return categoryUsesActual(c, s); });
  }
  function setAdjust(set, s) {
    let t = 0;
    Object.keys(set || {}).forEach(function (c) { if (categoryUsesActual(c, s)) t += categoryAdjust(c, s); });
    return t;
  }

  // cached read of categories + the last 5,000 txns, shared by every resolver below
  async function loadActuals(force) {
    if (_actualCache && !force) return _actualCache;
    const res = await Promise.all([
      rest('bd_bill_category?select=code,description'),
      rest('bd_card_txn?select=txn_date,amount,category_code&order=txn_date.desc&limit=5000')
    ]);
    _actualCache = { cats: res[0] || [], txns: res[1] || [], agg: actualByCategory12mo(res[1] || [], res[0] || []) };
    return _actualCache;
  }

  // Per-category coverage for the Bills Category page: 12-month total, txn count, and the flag.
  // Lets you see BEFORE ticking whether a category has any card spend behind it.
  async function categoryCoverage() {
    const s = await loadCategoryBasis(true);
    let a;
    try { a = await loadActuals(true); } catch (e) { return { basis: s.basis, endMonth: null, rows: {} }; }
    const rows = {};
    Object.keys(s.cats).forEach(function (code) {
      const e = a.agg.byCode[code];
      rows[code] = { code: code, description: s.cats[code].description,
                     use_actual: s.cats[code].use_actual, actual_adjust: s.cats[code].actual_adjust,
                     total: e ? e.total : 0, count: e ? e.count : 0 };
    });
    return { basis: s.basis, endMonth: a.agg.endMonth, rows: rows };
  }

  // The single figures the engine / budget / bills should consume, honouring the
  // saved basis. Callers pass the plan figures they already compute; on 'plan' those
  // are returned unchanged (identical to today). On 'actual' the trailing-12-month
  // totals + monthly adjustment×12 are used. If the actual data can't be read, it
  // falls back to plan so nothing ever breaks (degraded:true flags that).
  //
  // FUEL AND THE ACTUAL BASIS (ann11). Card spend on fuel cannot tell commuting from leisure
  // driving — it is one merchant category. But the engine needs the work/discretionary split,
  // because only the discretionary half tapers and only the work half stops at a date. So on
  // the 'actual' basis the combined actual figure is APPORTIONED using the plan's own
  // work:discretionary ratio. The total honours what you really spent; the split honours how
  // you said you drive. With no fuel plan keyed at all, it falls to discretionary.
  async function resolveDiscretionary(opts) {
    const planD = Number(opts && opts.diningPlanAnnual) || 0;
    const planH = Number(opts && opts.holidayPlanAnnual) || 0;
    const planFW = Number(opts && opts.fuelWorkPlanAnnual) || 0;
    const planFD = Number(opts && opts.fuelDiscPlanAnnual) || 0;
    const planOut = { basis: 'plan', diningActual: false, holidayActual: false, fuelActual: false,
                      diningAnnual: planD, holidayAnnual: planH, fuelWorkAnnual: planFW, fuelAnnual: planFD };
    let s2;
    try { s2 = await loadCategoryBasis(); } catch (e) { return planOut; }
    if (s2.basis === 'plan') return planOut;

    let a, cats;
    try { a = await loadActuals(); cats = a.cats; }
    catch (e) { return Object.assign({}, planOut, { degraded: true }); }
    const sets = discretionaryCodeSets(cats);

    // Each domain is resolved INDEPENDENTLY now. Under 'mixed' you can have dining on actuals
    // while holidays stay on plan; under 'actual' all three are on, as before.
    const dOn = setUsesActual(sets.dining, s2);
    const hOn = setUsesActual(sets.holiday, s2);
    const fOn = setUsesActual(sets.fuel, s2);

    const dining = dOn ? Math.max(0, Math.round(sumSet(a.agg.byCode, sets.dining) / 12 + setAdjust(sets.dining, s2)) * 12) : planD;
    const holiday = hOn ? Math.max(0, Math.round(sumSet(a.agg.byCode, sets.holiday) / 12 + setAdjust(sets.holiday, s2)) * 12) : planH;

    // Fuel keeps its apportionment: card spend can't tell commuting from leisure, so the actual
    // total is split by the PLAN's own work:discretionary ratio.
    let fW = planFW, fD = planFD;
    if (fOn) {
      const fActual = Math.max(0, Math.round(sumSet(a.agg.byCode, sets.fuel) / 12 + setAdjust(sets.fuel, s2)) * 12);
      const planFT = planFW + planFD;
      const workShare = planFT > 0 ? (planFW / planFT) : 0;
      fW = Math.round(fActual * workShare * 100) / 100;
      fD = Math.round(fActual * (1 - workShare) * 100) / 100;
    }
    return {
      // 'basis' stays the SAVED mode. Callers that need to know whether a particular domain is on
      // actuals must read diningActual / holidayActual / fuelActual — testing basis === 'actual'
      // is wrong under 'mixed' and will silently skip the rescale.
      basis: s2.basis,
      diningActual: dOn, holidayActual: hOn, fuelActual: fOn,
      diningAnnual: dining, holidayAnnual: holiday, fuelWorkAnnual: fW, fuelAnnual: fD
    };
  }

  // ---- Bill-backed categories on the Actual basis -------------------------------------
  // Two kinds of category exist and they differ in where the PLAN comes from:
  //   planner-backed (dining / holidays / fuel) -> resolveDiscretionary arbitrates two sources
  //   bill-backed    (everything else)          -> the bd_household_bills row IS the plan, so the
  //                                                actual simply OVERRIDES the amount on that row
  // This handles the second kind. It replaces the old hardcoded Julie special case: Julie is now
  // just a category with use_actual ticked, and nothing here knows her name.
  //
  // Apply wherever bills are CONSUMED. NEVER on bills.html / bills_categories.html, where the row
  // is EDITED — an actual figure in an editable field invites saving it back over the plan.

  let _billOverrideWarn = null;   // codes flagged but with no bill row to override (diagnostic)

  // Returns a NEW bills array; the input is never mutated, because several pages hand the same
  // rows to more than one engine run and a mutated row would compound across runs.
  //
  // Rows are rewritten rather than replaced, so spend_reduction and the age-taper flags set on each
  // row keep working: the basis changes the AMOUNT, not the BEHAVIOUR.
  //
  // The row is normalised to MONTHLY at annual/12 with a full pay_months mask — NOT to Annual.
  // Annual looks tidier but is wrong: monthCharge() lands an annual bill entirely in its bill_month,
  // so a rewritten row would dump the whole year into one month on Budget and What I Could Save, or
  // show zero if the row has no bill_month at all. A full-mask monthly row costs premium x 12 in the
  // engine (identical total) and spreads evenly in every month-by-month view, which is what
  // "annual / 12" is supposed to mean.
  //
  // Where a category has several bill rows the actual is split across them in proportion to their
  // planned share, with the last row absorbing the rounding remainder.
  async function applyCategoryBasis(bills) {
    const src = bills || [];
    let s2;
    try { s2 = await loadCategoryBasis(); } catch (e) { return src; }
    if (s2.basis === 'plan') return src;

    let a, cats;
    try { a = await loadActuals(); cats = a.cats; } catch (e) { return src; }
    const sets = discretionaryCodeSets(cats);
    // planner-backed domains are handled by resolveDiscretionary, not here — overriding their bill
    // rows too would double-count them
    const skip = {};
    [sets.dining, sets.holiday, sets.fuel, sets.reimburse].forEach(function (st) {
      Object.keys(st || {}).forEach(function (c) { skip[c] = true; });
    });

    // which flagged categories actually have bill rows?
    const byCat = {};
    src.forEach(function (b, i) {
      const cd = b && b.category_code;
      if (!cd || skip[cd]) return;
      if (!categoryFlagged(cd, s2)) return;
      (byCat[cd] = byCat[cd] || []).push(i);
    });

    // diagnostics surfaced on the Bills Category page
    const warn = [];
    Object.keys(s2.cats).forEach(function (cd) {
      if (skip[cd] || !categoryFlagged(cd, s2)) return;
      if (!byCat[cd] && a.agg.byCode[cd]) warn.push(cd);
    });
    if (!Object.keys(byCat).length) { _billOverrideWarn = warn; return src; }
    const out = src.slice();
    Object.keys(byCat).forEach(function (cd) {
      const idx = byCat[cd];
      const e = a.agg.byCode[cd];
      // Flagged but not a single card transaction in the window? Leave the planned bill alone and
      // warn. Zeroing a real cost on no evidence is far worse than under-reporting one — a genuine
      // £0 is indistinguishable here from "you flagged a direct-debit category by mistake".
      if (!e || !e.count) { warn.push(cd); return; }
      const annual = Math.max(0, e.total + categoryAdjust(cd, s2) * 12);
      const planTot = idx.reduce(function (t, i) { return t + (Number(src[i].total_annual) || 0); }, 0);
      let assigned = 0;
      idx.forEach(function (i, k) {
        const share = planTot > 0 ? ((Number(src[i].total_annual) || 0) / planTot) : (k === 0 ? 1 : 0);
        const amt = (k === idx.length - 1) ? Math.round((annual - assigned) * 100) / 100
                                           : Math.round(annual * share * 100) / 100;
        assigned = Math.round((assigned + amt) * 100) / 100;
        out[i] = Object.assign({}, src[i], {
          frequency: 'Monthly', pay_months: '111111111111',
          premium: Math.round(amt / 12 * 100) / 100, total_annual: amt,
          bill_month: null, actual_basis: true, actual_code: cd
        });
      });
    });
    _billOverrideWarn = warn;   // recorded last: the loop above adds no-evidence codes too
    return out;
  }
  // codes flagged for actuals that either had no bill row to carry the spend, or no card
  // transactions at all in the window — both mean the flag did nothing — populated by the
  // last applyCategoryBasis() call, surfaced as a warning on the Bills Category page
  function billOverrideWarnings() { return _billOverrideWarn || []; }

  // Deprecated alias kept so a half-finished deploy can't break: pages still calling the old name
  // get the general behaviour. Remove once every page is on applyCategoryBasis.
  async function applyJulieBasis(bills) { return applyCategoryBasis(bills); }

  // Save one category's actual-basis settings. PATCH by code; the caller owns the UI state.
  async function saveCategoryActual(code, useActual, adjust) {
    await write('PATCH', 'bd_bill_category?code=eq.' + encodeURIComponent(code), {
      use_actual: !!useActual,
      actual_adjust: Number(adjust) || 0
    });
    _catBasisCache = null; _actualCache = null;
  }

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

  // When we are the top-level shell, fan an "active" signal out to every frame
  // so hidden sub-pages don't run independent idle countdowns that your activity
  // never resets. Frames only bump on receipt (they don't re-broadcast), so no loop.
  const isTopShell = (window.parent === window);
  function relayActivityToFrames() {
    if (!isTopShell) return;
    try {
      document.querySelectorAll('iframe').forEach(function (f) {
        try { if (f.contentWindow) f.contentWindow.postMessage('app-activity', '*'); } catch (e) {}
      });
    } catch (e) {}
  }

  function startIdleWatch() {
    ['click', 'keydown', 'mousemove', 'scroll', 'touchstart', 'touchmove'].forEach(function (ev) {
      window.addEventListener(ev, onLocalActivity, { passive: true });
    });
    // If we're embedded in a parent (iframe), tell the parent we're active too.
    // If we're the parent, accept activity pings from our frames and pass them on
    // to all the other frames so the whole app stays alive together.
    window.addEventListener('message', function (e) {
      if (e && e.data === 'app-activity') { bumpActivity(); relayActivityToFrames(); }
    });
    bumpActivity(); // start the clock
  }

  function onLocalActivity() {
    bumpActivity();
    // notify parent (no-op if we're not embedded)
    try { if (window.parent && window.parent !== window) window.parent.postMessage('app-activity', '*'); } catch (e) {}
    // if we're the shell, keep every frame alive too
    relayActivityToFrames();
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
    rest: rest, rpc: rpc, write: write, memberNames: memberNames,
    fmt: fmt, fmtDiff: fmtDiff, parseLocalDate: parseLocalDate, toInputDate: toInputDate,
    holidayCtx: holidayCtx, holidayWeekBreakdown: holidayWeekBreakdown,
    holidayWeekTotal: holidayWeekTotal, holidayAnnual: holidayAnnual,
    HOLIDAY_MEALS: HOLIDAY_MEALS,
    fuelCtx: fuelCtx, fuelLineCost: fuelLineCost, fuelWeekLines: fuelWeekLines,
    fuelWeekBreakdown: fuelWeekBreakdown, fuelWeekTotal: fuelWeekTotal, fuelAnnual: fuelAnnual,
    loadFuelForEngine: loadFuelForEngine, clearCaches: clearCaches,
    FUEL_PURPOSES: FUEL_PURPOSES, FUEL_WORK: FUEL_WORK,
    loadDiscretionaryBasis: loadDiscretionaryBasis, saveDiscretionaryBasis: saveDiscretionaryBasis,
    actualDiscretionary12mo: actualDiscretionary12mo, resolveDiscretionary: resolveDiscretionary,
    discretionaryCodeSets: discretionaryCodeSets,
    actualByCategory12mo: actualByCategory12mo,
    loadCategoryBasis: loadCategoryBasis, categoryUsesActual: categoryUsesActual,
    categoryAdjust: categoryAdjust, categoryCoverage: categoryCoverage,
    applyCategoryBasis: applyCategoryBasis, billOverrideWarnings: billOverrideWarnings,
    applyJulieBasis: applyJulieBasis, saveCategoryActual: saveCategoryActual,
    requireLogin: requireLogin, doLogin: doLogin, doLogout: doLogout,
    token: () => authToken
  };

})(window);
