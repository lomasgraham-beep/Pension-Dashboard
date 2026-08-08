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

  // ---- session caches ------------------------------------------------------------------
  // Drops the session-lifetime caches so the next read goes to the database. Call before a manual
  // in-page refresh: the actuals cache otherwise survives for the life of the tab, so a changed
  // Use-actual tick or adjust would never show up without a full reload.
  //
  // bd_discretionary_basis is RETIRED as of this build. Dining, Holidays and Fuel are rows in
  // bd_actual_costs like everything else, each with its own `active` tick, so the single global
  // basis flag no longer exists. The table is left in place, inert, so the change is revertible.
  function clearCaches() { _actualCache = null; }

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

  // ---- Dining / Holidays / Fuel (planner-backed) ---------------------------------------
  // These three are now rows in bd_actual_costs alongside every other category, one row each,
  // each with its own `active` tick — so Dining can be driven by real card spend while Holidays
  // stays on the plan. That independence is the whole reason the old single global `basis` flag
  // was retired.
  //
  // They are NOT handled by applyActualCosts, and that asymmetry is deliberate — do not "tidy"
  // it away. applyActualCosts works by dropping a category's bill rows and pushing one synthetic
  // row in their place. These three have no bill rows, they have planners, so there would be
  // nothing to drop and the synthetic row would be ADDED ON TOP of the planner figure. Double
  // counting. The plannerCodes guard inside applyActualCosts is what prevents that.
  //
  // They are resolved here instead. Every consumer already passes its plan figures in and reads
  // diningActual / holidayActual / fuelActual back, so switching a domain to actuals needs no
  // change on any calling page.
  async function resolveDiscretionary(opts) {
    const planD = Number(opts && opts.diningPlanAnnual) || 0;
    const planH = Number(opts && opts.holidayPlanAnnual) || 0;
    const planFW = Number(opts && opts.fuelWorkPlanAnnual) || 0;
    const planFD = Number(opts && opts.fuelDiscPlanAnnual) || 0;
    const planOut = { basis: 'plan', diningActual: false, holidayActual: false, fuelActual: false,
                      diningAnnual: planD, holidayAnnual: planH, fuelWorkAnnual: planFW, fuelAnnual: planFD };

    let a;
    try { a = await loadActualCosts(); } catch (e) { return Object.assign({}, planOut, { degraded: true }); }
    const sets = discretionaryCodeSets(a.cats || []);

    // An ACTIVE row on any code in the domain's set switches that domain to actuals. The adjust is
    // ANNUAL — the same unit as every other row on the Actual Costs page — and is applied to the
    // 12-month card total before the floor, so a domain can legitimately be stated from the adjust
    // alone when there is no card trail. Floored at zero: never a negative cost.
    function domain(set) {
      let on = false, adjust = 0, total = 0, count = 0;
      (a.rows || []).forEach(function (r) {
        if (!r.category_code || !set[r.category_code] || r.active !== true) return;
        on = true;
        adjust += Number(r.adjust) || 0;
        const e = a.agg.byCode[r.category_code];
        if (e) { total += e.total; count += e.count; }
      });
      return { on: on, annual: Math.max(0, Math.round((total + adjust) * 100) / 100), count: count };
    }

    const d = domain(sets.dining), h = domain(sets.holiday), f = domain(sets.fuel);
    if (!d.on && !h.on && !f.on) return planOut;

    // Fuel keeps its apportionment: card spend cannot tell commuting from leisure, so the actual
    // total is split by the PLAN's own work:discretionary ratio.
    const planFT = planFW + planFD;
    const workShare = planFT > 0 ? (planFW / planFT) : 0;

    return {
      // DIAGNOSTIC ONLY. Nothing may branch on this string — the three flags below are the
      // contract. A scattered comparison against a mode string is exactly how 'mixed' broke
      // before; the per-domain flags cannot drift the same way.
      basis: (d.on && h.on && f.on) ? 'actual' : 'mixed',
      diningActual: d.on, holidayActual: h.on, fuelActual: f.on,
      diningAnnual: d.on ? d.annual : planD,
      holidayAnnual: h.on ? h.annual : planH,
      fuelWorkAnnual: f.on ? Math.round(f.annual * workShare * 100) / 100 : planFW,
      fuelAnnual: f.on ? Math.round(f.annual * (1 - workShare) * 100) / 100 : planFD,
      diningTxns: d.count, holidayTxns: h.count, fuelTxns: f.count
    };
  }

  // ---- Actual costs (bd_actual_costs) --------------------------------------------------
  // A row here says: "this category is driven by real card spend, not by its planned bill rows."
  // One row per category. When active, applyActualCosts() DROPS every bill row in that category
  // and substitutes ONE synthetic row carrying the 12-month card total / 12, the paid-by and
  // account you chose, and the three age tapers set on the row.
  //
  // Each row also carries an ANNUAL `adjust` (default 0) which is added to the 12-month card
  // total before anything else happens. It exists because the card is not always the whole story:
  // a category may be part cash, or carry a known cost with no card trail, or contain a one-off
  // that should not be projected forward. The adjusted total is floored at zero — a negative
  // adjust bigger than the spend gives £0, never a negative bill.
  //
  // Suppress-and-replace, not mutate. Two consequences that matter:
  //   - No proportional split across rows, so a category's whole actual lands on one line.
  //   - The real bill rows are untouched in the database, so deactivating a row restores the plan
  //     instantly. Nothing is ever destroyed by switching a category to actuals.
  //
  // Dining / Holidays / Fuel are excluded by code — they are planner-backed and keep the Plan /
  // Actual switch on the Weekly Plan page. A row for one of those would silently do nothing, so
  // the Actual Costs page blocks them rather than letting you create one.

  let _actualCache = null;   // { rows, cats, txns, agg } for the life of the tab

  // Codes that are planner-backed and must never be driven from this table.
  function plannerCodes(catRows) {
    const sets = discretionaryCodeSets(catRows);
    const out = {};
    [sets.dining, sets.holiday, sets.fuel, sets.reimburse].forEach(function (st) {
      Object.keys(st || {}).forEach(function (c) { out[c] = true; });
    });
    return out;
  }

  async function loadActualCosts(force) {
    if (_actualCache && !force) return _actualCache;
    const res = await Promise.all([
      rest('bd_actual_costs?order=category_code.asc'),
      rest('bd_bill_category?select=code,description'),
      rest('bd_card_txn?select=txn_date,amount,category_code&order=txn_date.desc&limit=5000')
    ]);
    const cats = res[1] || [], txns = res[2] || [];
    _actualCache = { rows: res[0] || [], cats: cats, txns: txns,
                     agg: actualByCategory12mo(txns, cats), planner: plannerCodes(cats) };
    return _actualCache;
  }

  // Everything the Actual Costs page needs to draw itself: each row plus its live 12-month total,
  // transaction count and the window end. The figure is computed on every read, never stored — a
  // saved snapshot would go stale the moment a statement is imported and silently disagree with
  // the transactions behind it.
  async function actualCostRows() {
    const a = await loadActualCosts(true);
    const desc = {};
    (a.cats || []).forEach(function (c) { desc[c.code] = c.description; });
    return {
      endMonth: a.agg.endMonth,
      planner: a.planner,
      cats: a.cats,
      rows: (a.rows || []).map(function (r) {
        const e = a.agg.byCode[r.category_code];
        const annual = e ? e.total : 0;
        const adjust = Number(r.adjust) || 0;
        const net = Math.max(0, annual + adjust);
        // `annual` stays the RAW card total so the page can always show what the transactions
        // actually said; `net_annual` / `monthly` are what the model will use.
        return Object.assign({}, r, {
          description: desc[r.category_code] || r.category_code,
          annual: annual, adjust: adjust,
          net_annual: Math.round(net * 100) / 100,
          monthly: Math.round(net / 12 * 100) / 100,
          txn_count: e ? e.count : 0,
          is_planner: !!a.planner[r.category_code]
        });
      })
    };
  }

  // Returns a NEW bills array with every ACTIVE category's bill rows replaced by one synthetic
  // row. Input is never mutated — several pages hand the same rows to more than one engine run.
  //
  // The synthetic row is shaped as MONTHLY at annual/12 with a full pay_months mask, never as
  // Annual: monthCharge() lands an annual bill entirely in its bill_month, which would dump the
  // whole year into one month on Budget and What I Could Save, or show zero for a row with no
  // bill_month. A full-mask monthly row costs premium x 12 in the engine and spreads evenly in
  // every month-by-month view, which is what "annual / 12" is supposed to mean.
  async function applyActualCosts(bills) {
    const src = bills || [];
    let a;
    try { a = await loadActualCosts(); } catch (e) { return src; }
    const active = (a.rows || []).filter(function (r) {
      return r.active === true && r.category_code && !a.planner[r.category_code];
    });
    if (!active.length) return src;

    const desc = {};
    (a.cats || []).forEach(function (c) { desc[c.code] = c.description; });
    const drop = {};
    active.forEach(function (r) { drop[r.category_code] = true; });

    const out = src.filter(function (b) { return !(b && drop[b.category_code]); });
    active.forEach(function (r) {
      const e = a.agg.byCode[r.category_code];
      // Annual adjust applied before the floor, so a category with no card trail at all can still
      // be stated purely from the adjust, and a negative adjust can only take a cost down to zero.
      const annual = Math.max(0, (e ? e.total : 0) + (Number(r.adjust) || 0));
      out.push({
        bill_name: (desc[r.category_code] || r.category_code) + ' (actual)',
        category_code: r.category_code,
        paid_by: r.paid_by || null,
        paid_account: r.paid_account || null,
        frequency: 'Monthly',
        premium: Math.round(annual / 12 * 100) / 100,
        total_annual: annual,
        pay_months: '111111111111',
        bill_month: null,
        renewal_date: null,
        spend_reduction: r.spend_reduction === true,
        taper_at_70: r.taper_at_70 != null ? Number(r.taper_at_70) : 1,
        taper_at_80: r.taper_at_80 != null ? Number(r.taper_at_80) : 1,
        taper_at_90: r.taper_at_90 != null ? Number(r.taper_at_90) : 1,
        actual_basis: true, actual_code: r.category_code, txn_count: e ? e.count : 0,
        actual_adjust: Number(r.adjust) || 0
      });
    });
    return out;
  }

  async function saveActualCost(row) {
    const payload = {
      category_code: row.category_code, paid_by: row.paid_by || null,
      paid_account: row.paid_account || null, active: !!row.active,
      spend_reduction: !!row.spend_reduction,
      adjust: Number(row.adjust) || 0,
      taper_at_70: Number(row.taper_at_70) || 1,
      taper_at_80: Number(row.taper_at_80) || 1,
      taper_at_90: Number(row.taper_at_90) || 1
    };
    if (row.id) await write('PATCH', 'bd_actual_costs?id=eq.' + encodeURIComponent(row.id), payload);
    else await write('POST', 'bd_actual_costs', payload);
    _actualCache = null;
  }
  async function deleteActualCost(id) {
    await write('DELETE', 'bd_actual_costs?id=eq.' + encodeURIComponent(id), null);
    _actualCache = null;
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
    actualDiscretionary12mo: actualDiscretionary12mo, resolveDiscretionary: resolveDiscretionary,
    discretionaryCodeSets: discretionaryCodeSets,
    actualByCategory12mo: actualByCategory12mo,
    loadActualCosts: loadActualCosts, actualCostRows: actualCostRows,
    applyActualCosts: applyActualCosts, saveActualCost: saveActualCost,
    deleteActualCost: deleteActualCost,
    requireLogin: requireLogin, doLogin: doLogin, doLogout: doLogout,
    token: () => authToken
  };

})(window);
