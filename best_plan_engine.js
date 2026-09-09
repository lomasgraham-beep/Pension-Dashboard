/* ============================================================
   best_plan_engine.js — Intelligent Modelling sandbox controller
   build: bpe9 / target app build LC-525

   Uses the existing PensionEngine as the single source of pension maths.
   It never mutates the main Modelling page state and never writes to Supabase.
   ============================================================ */
(function (global) {
  'use strict';

  const BUILD = 'bpe9';
  const ANN_NAME = 'Best Plan Finder Annuity';
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), 1);
    if (global.App && App.parseLocalDate) return App.parseLocalDate(v);
    const p = String(v).split('T')[0].split('-').map(Number);
    if (p.length >= 3 && p[0]) return new Date(p[0], p[1] - 1, p[2]);
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function toInputDate(d) {
    if (!d) return '';
    if (typeof d === 'string') return d.split('T')[0];
    if (global.App && App.toInputDate) return App.toInputDate(d);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function monthIdx(d) { d = parseDate(d); return d.getFullYear() * 12 + d.getMonth(); }
  function idxToDate(idx) { return new Date(Math.floor(idx / 12), ((idx % 12) + 12) % 12, 1); }
  function dateLabel(d) { d = parseDate(d); return d ? MONTHS[d.getMonth()] + ' ' + d.getFullYear() : '—'; }
  function gbp(n) { return '£' + Math.round(Number(n) || 0).toLocaleString('en-GB'); }
  function deepClone(v) { return JSON.parse(JSON.stringify(v || {})); }
  function clonePlan(p) {
    const out = Object.assign({}, p || {});
    ['retirementDate','phase1Date','phase2Date'].forEach(k => { if (out[k]) out[k] = parseDate(out[k]); });
    if (out.retireByMember) {
      const rbm = {};
      Object.keys(out.retireByMember).forEach(k => { rbm[k] = parseDate(out.retireByMember[k]); });
      out.retireByMember = rbm;
    }
    return out;
  }

  // Month index (year*12 + 0-based month) read from the digits of a YYYY-MM-DD string rather than
  // via new Date(). A bare date string parses as UTC midnight while the engine's month cursor is
  // LOCAL midnight, so under BST a date on the 1st compares as belonging to the previous month.
  function schedMonthIdx(s) {
    const m = /^(\d{4})-(\d{2})/.exec(String(s || ''));
    return m ? (Number(m[1]) * 12 + Number(m[2]) - 1) : null;
  }
  // Working-days tier in force for a member at a month index (latest from_date on or before it).
  function tierDaysAt(tiers, member, idx) {
    let best = null, bestIdx = -Infinity;
    (tiers || []).forEach(t => {
      if (t.member_name !== member) return;
      const i = schedMonthIdx(t.from_date);
      if (i == null || i > idx || i <= bestIdx) return;
      bestIdx = i; best = Number(t.days);
    });
    return best;
  }
  // bpe9: bd_pension_contributions is only a MIRROR of the schedule value in force today, written
  // solely by contributions.html when a schedule row is saved — nothing refreshes it as time passes.
  // A step therefore goes live on its effective date while the mirror keeps the previous figure, and
  // expandFutureSteps deliberately skips current/past steps on the assumption the mirror is current.
  // Re-resolve the mirror in memory so that assumption actually holds. Matches contributions.html's
  // inForceEntry(): latest step on or before this month whose tier tag is "All" (null) or equal to
  // the row's own working_days. Returns a NEW array; nothing is written back to Supabase.
  function resolveContribMirror(contributions, schedule) {
    const rows = contributions || [];
    if (!schedule || !schedule.length) return rows.slice();
    const now = new Date();
    const nowIdx = now.getFullYear() * 12 + now.getMonth();
    return rows.map(r => {
      let best = null, bestIdx = -Infinity;
      schedule.forEach(e => {
        if (e.member_name !== r.member_name || e.pension_name !== r.pension_name) return;
        const wd = e.working_days;
        if (!(wd == null || wd === '' || (r.working_days != null && Number(wd) === Number(r.working_days)))) return;
        const i = schedMonthIdx(e.effective_from);
        if (i == null || i > nowIdx || i <= bestIdx) return;
        bestIdx = i; best = e;
      });
      if (!best) return r;
      const out = Object.assign({}, r, { monthly_contribution: Number(best.monthly_value) || 0 });
      if (best.increase_pct != null && best.increase_pct !== '') out.august_increase_pct = Number(best.increase_pct);
      if (best.increase_month != null) out.increase_month = Number(best.increase_month);
      if (best.paid_account != null && best.paid_account !== '') out.paid_account = best.paid_account;
      return out;
    });
  }

  // bpe9: identical in behaviour to the copy in app.html. A schedule row dated in the future is
  // turned into a contribution override starting on that date; current and past rows are supplied
  // by resolveContribMirror above.
  // A step tagged for a specific working pattern is only injected when that pattern is the tier
  // actually in force on its effective date. Without that test a 5-day-tagged (or "All") step would
  // override a 3-day contribution, because the engine's exceptionFor() matches on member + pension
  // alone and knows nothing about working_days.
  function expandFutureSteps(schedule, tiers) {
    const now = new Date();
    const nowIdx = now.getFullYear() * 12 + now.getMonth();
    const out = [];
    (schedule || []).forEach(e => {
      const idx = schedMonthIdx(e.effective_from);
      if (idx == null || idx <= nowIdx) return;
      const wd = e.working_days;
      if (!(wd == null || wd === '')) {
        const days = tierDaysAt(tiers, e.member_name, idx);
        if (days == null || Number(wd) !== Number(days)) return;
      }
      out.push({
        member_name: e.member_name, pension_name: e.pension_name,
        start_date: e.effective_from, end_date: null,
        contribution_value: Number(e.monthly_value) || 0, one_off: false
      });
    });
    out.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
    return out;
  }

  async function loadState() {
    if (!global.App || !App.rest) throw new Error('App helpers are not loaded.');
    if (!global.PensionEngine) throw new Error('PensionEngine is not loaded.');
    const [members, bills, dining, guaranteed, pensions, contributions, logs, purchases, crashes, savingsAccounts, contributionExceptions, workingTiers, incomeSources, incomeAmounts, diningRota, mealCost, annuities, holidayPlan, holidayCost, holidaySettings, diningSettings, contributionSchedule] = await Promise.all([
      // bpe7: bills MUST go through applyActualCosts, exactly as app.html and every other engine
      // caller does. Without it this page ran a hybrid cost base — planned bills for every ordinary
      // category, but ACTUAL dining / holidays / fuel (those arrive via resolveDiscretionary below,
      // which was already wired). Any category ticked on the Actual Costs page was silently ignored
      // here and only here, so Best Plan, MSS and Earliest Retirement Age were answered against a
      // household cost the main dashboard never shows.
      App.rest('bd_members'), App.rest('bd_household_bills').then(App.applyActualCosts), App.rest('bd_dining_habits'),
      App.rest('bd_guaranteed_incomes'), App.rest('bd_pensions'),
      App.rest('bd_pension_contributions'), App.rest('op_pension_logs?order=log_date.desc'),
      App.rest('bd_purchases?order=purchase_date.asc'),
      App.rest('bd_market_crashes?order=start_date.asc'),
      App.rest('bd_savings_accounts?order=account_name.asc'),
      App.rest('bd_contribution_exceptions?order=start_date.asc'),
      App.rest('bd_working_tiers?order=from_date.asc'),
      App.rest('bd_income_sources?order=member_name.asc'),
      App.rest('bd_income_amounts?order=member_name.asc'),
      App.rest('bd_dining_rota'),
      App.rest('bd_meal_cost'),
      App.rest('bd_annuities?order=purchase_date.asc'),
      App.rest('bd_holiday_plan?phase=eq.retired&order=week_no.asc'),
      App.rest('bd_holiday_cost'),
      App.rest('bd_holiday_settings?id=eq.1'),
      // bpe8: two more things app.html sends the engine and this page did not.
      // bd_dining_settings carries the dining age taper; without it the engine defaults to 1.0 and
      // dining never reduces with age here, so late-life costs ran high and Earliest Retirement Age
      // ran late. bd_contribution_schedule holds future-dated contribution changes, which app.html
      // expands into engine overrides — unexpanded, any contribution change dated ahead simply
      // never happened in this page's world.
      App.rest('bd_dining_settings?id=eq.1'),
      App.rest('bd_contribution_schedule?order=effective_from.asc')
    ]);
    const mealCostMap = {};
    (mealCost || []).forEach(c => { mealCostMap[c.meal_type + '|' + c.level] = Number(c.cost) || 0; });
    const DAY_COLS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const diningPlanAnnual = (diningRota || []).reduce((sum, r) => sum + DAY_COLS.reduce((s, col) => s + (r[col] ? (mealCostMap[r.meal_type + '|' + r[col]] || 0) : 0), 0), 0);
    const holidayPlanAnnual = App.holidayAnnual(holidayPlan || [], App.holidayCtx(holidayCost || [], mealCost || [], (holidaySettings && holidaySettings[0]) || {}), 'retired');
    // Budget basis: Plan (above) or Actual last-12-months + adjustment, per the saved choice.
    // ann11: fuel is its own engine term now, no longer inside the holiday figure.
    const _fuel = await App.loadFuelForEngine();
    const _eff = await App.resolveDiscretionary({ diningPlanAnnual: diningPlanAnnual, holidayPlanAnnual: holidayPlanAnnual,
        fuelWorkPlanAnnual: _fuel.planWork, fuelDiscPlanAnnual: _fuel.planDisc });
    const diningAnnual = _eff.diningAnnual, holidayAnnual = _eff.holidayAnnual;
    const fuelDiscAnnual = _eff.fuelAnnual, fuelWorkAnnual = _eff.fuelWorkAnnual;
    let giftRows = []; try { giftRows = await App.rest('bd_gift_savings?order=gift_type.asc,sort_order.asc,id.asc') || []; } catch (e) { giftRows = []; }
    const _hs = (holidaySettings && holidaySettings[0]) || {};
    const _ds = (diningSettings && diningSettings[0]) || {};
    const holidayTaper = { taper_at_70: _hs.taper_at_70, taper_at_80: _hs.taper_at_80, taper_at_90: _hs.taper_at_90 };
    const diningTaper = { taper_at_70: _ds.taper_at_70, taper_at_80: _ds.taper_at_80, taper_at_90: _ds.taper_at_90 };
    const _tiers = workingTiers || [];
    const _sched = contributionSchedule || [];
    const _liveContribs = resolveContribMirror(contributions || [], _sched);
    const data = { members, bills, gifts: giftRows, dining, diningAnnual, holidayAnnual, holidayTaper: holidayTaper, diningTaper: diningTaper, fuelAnnual: fuelDiscAnnual, fuelWorkAnnual: fuelWorkAnnual, fuelTaper: _fuel.taper, fuelWorkEndDate: _fuel.workEndsOn, guaranteed, pensions, contributions: _liveContribs, logs, purchases: purchases || [], crashes: crashes || [], savingsAccounts: savingsAccounts || [], contributionExceptions: expandFutureSteps(_sched, _tiers).concat(contributionExceptions || []), contributionRateHistory: _sched, workingTiers: _tiers, incomeSources: incomeSources || [], incomeAmounts: incomeAmounts || [], annuities: annuities || [] };
    const sortedM = (members || []).slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const p1Name = sortedM[0] ? sortedM[0].name : 'Graham';
    const p2Name = sortedM[1] ? sortedM[1].name : null;

    const pRows = await App.rest('op_modelling_parameters?member_name=eq.' + encodeURIComponent(p1Name) + '&order=updated_at.desc&limit=1');
    const p = (pRows && pRows.length) ? pRows[0] : {};
    let p2phase = null, p2row = null;
    if (p2Name) {
      const p2Rows = await App.rest('op_modelling_parameters?member_name=eq.' + encodeURIComponent(p2Name) + '&order=updated_at.desc&limit=1');
      p2row = (p2Rows && p2Rows.length) ? p2Rows[0] : null;
      if (p2row) p2phase = {
        phase1Date: parseDate(p2row.shorter_week_date_1), phase1Days: p2row.working_days_1 ? Number(p2row.working_days_1) : 5,
        phase2Date: parseDate(p2row.shorter_week_date_2), phase2Days: p2row.working_days_2 ? Number(p2row.working_days_2) : 5
      };
    }
    const p1Retire = parseDate(p.retirement_date);
    const p2Retire = (p2row && p2row.retirement_date) ? parseDate(p2row.retirement_date) : p1Retire;
    const retireByMember = {};
    if (p1Name && p1Retire) retireByMember[p1Name] = p1Retire;
    if (p2Name && p2Retire) retireByMember[p2Name] = p2Retire;
    const latestRetire = [p1Retire, p2Retire].filter(Boolean).sort((a, b) => b - a)[0] || p1Retire || new Date(new Date().getFullYear() + 5, 0, 1);
    const basePlan = {
      retirementDate: latestRetire,
      retireByMember: retireByMember,
      growthRate: p.pension_growth_rate != null ? Number(p.pension_growth_rate) : 0.05,
      phase1Date: parseDate(p.shorter_week_date_1), phase1Days: p.working_days_1 ? Number(p.working_days_1) : 5,
      phase2Date: parseDate(p.shorter_week_date_2), phase2Days: p.working_days_2 ? Number(p.working_days_2) : 5,
      p2phase: p2phase,
      spendRed: p.spending_reduction_pct != null ? Number(p.spending_reduction_pct) : 1,
      gRatio: p.drawdown_ratio_graham != null ? Number(p.drawdown_ratio_graham) : 0.5,
      savingsFundBills: p.savings_fund_bills != null ? !!p.savings_fund_bills : true,
      withdrawalMethodGraham: p.withdrawal_method_graham === 'fad' ? 'fad' : 'ufpls',
      withdrawalMethodJulie: p.withdrawal_method_julie === 'fad' ? 'fad' : 'ufpls',
      crystallisationDateGraham: p.crystallisation_date_graham || null,
      crystallisationDateJulie: p.crystallisation_date_julie || null,
      ufplsDivertTf: !!p.ufpls_divert_tf,
      retired: p.retired_mode != null ? !!p.retired_mode : false,
      dynamic: false,
      gFloorPct: 0,
      jFloorPct: 0,
      spRate: 0.025,
      spDelay: 0,
      tierDateOverrides: null
    };
    data.paramsByMember = {};
    if (p1Name) data.paramsByMember[p1Name] = p;
    if (p2Name && p2row) data.paramsByMember[p2Name] = p2row;
    return { data, basePlan, p1Name, p2Name, build: BUILD };
  }

  function applyWithdrawalMode(plan, mode, fadDate) {
    mode = mode || 'current';
    if (mode === 'current') return plan;
    if (mode === 'ufpls') {
      plan.withdrawalMethodGraham = 'ufpls'; plan.withdrawalMethodJulie = 'ufpls';
      plan.crystallisationDateGraham = null; plan.crystallisationDateJulie = null; plan.ufplsDivertTf = false;
    } else if (mode === 'tffirst') {
      plan.withdrawalMethodGraham = 'fad'; plan.withdrawalMethodJulie = 'fad';
      const d = toInputDate(plan.retirementDate);
      plan.crystallisationDateGraham = d; plan.crystallisationDateJulie = d;
    } else if (mode === 'faddate') {
      plan.withdrawalMethodGraham = 'fad'; plan.withdrawalMethodJulie = 'fad';
      const d = toInputDate(parseDate(fadDate) || plan.retirementDate);
      plan.crystallisationDateGraham = d; plan.crystallisationDateJulie = d;
    }
    return plan;
  }

  function scenarioPlan(state, opts) {
    const plan = clonePlan(state.basePlan);
    if (opts.retirementDate) plan.retirementDate = parseDate(opts.retirementDate);
    if (opts.retireByMember !== undefined) plan.retireByMember = opts.retireByMember;
    if (opts.growthRate != null) plan.growthRate = Number(opts.growthRate);
    if (opts.spendRed != null) plan.spendRed = Number(opts.spendRed);
    if (opts.gRatio != null) plan.gRatio = Number(opts.gRatio);
    if (opts.spRate != null) plan.spRate = Number(opts.spRate);
    if (opts.spDelay != null) plan.spDelay = Number(opts.spDelay) || 0;
    if (opts.savingsFundBills != null) plan.savingsFundBills = !!opts.savingsFundBills;
    if (opts.dynamic != null) plan.dynamic = !!opts.dynamic;
    if (opts.gFloorPct != null) plan.gFloorPct = Number(opts.gFloorPct) || 0;
    if (opts.jFloorPct != null) plan.jFloorPct = Number(opts.jFloorPct) || 0;
    return applyWithdrawalMode(plan, opts.withdrawalMode, opts.fadDate);
  }

  function ownerToMember(state, owner) {
    if (owner === 'julie') return state.p2Name || state.p1Name;
    return state.p1Name || 'Graham';
  }

  function scenarioData(state, opts) {
    const d = deepClone(state.data);
    let anns = d.annuities || [];
    anns = anns.filter(a => String(a.annuity_name || a.name || '') !== ANN_NAME);
    if (!opts.includeExistingAnnuities) anns = [];
    if (opts.includeBestPlanAnnuity) {
      anns.push({
        annuity_name: ANN_NAME,
        member_name: ownerToMember(state, opts.owner || 'graham'),
        purchase_date: toInputDate(opts.annuityDate),
        purchase_amount: Number(opts.annuityAmount) || 0,
        annuity_rate: Number(opts.annuityRate) || 0,
        escalation_pct: Number(opts.escalationPct) || 0,
        enabled: true,
        use_whole_pot: false
      });
    }
    d.annuities = anns;
    if (!opts.includeCrashes) d.crashes = [];
    return d;
  }

  function buildDrawdownCfg(state, runData, plan) {
    const stateNames = new Set((runData.guaranteed || []).map(x => x.income_name).filter(n => n && String(n).toLowerCase().indexOf('state') >= 0));
    const js = PensionEngine.forecast(runData, plan, 1);
    const pots = { graham: Math.max(0, Number(js.graham) || 0), julie: Math.max(0, Number(js.julie) || 0) };
    const retired = !!plan.retired;
    const nowFirst = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const baseRetire = retired ? nowFirst : plan.retirementDate;
    let retireByMember = plan.retireByMember || null;
    if (retired) { retireByMember = {}; if (state.p1Name) retireByMember[state.p1Name] = nowFirst; if (state.p2Name) retireByMember[state.p2Name] = nowFirst; }
    const ownRetirePots = js.potsAtOwnRetire ? { graham: js.potsAtOwnRetire.p1 || 0, julie: js.potsAtOwnRetire.p2 || 0 } : pots;
    const startYr = baseRetire ? baseRetire.getFullYear() : new Date().getFullYear();
    const sp = PensionEngine.baselineSP(stateNames);
    if (plan.spRate != null) sp.spRate = plan.spRate;
    const dly = plan.spDelay || 0;
    sp.spDelay = {};
    if (state.p1Name) sp.spDelay[state.p1Name] = dly;
    if (state.p2Name) sp.spDelay[state.p2Name] = dly;
    return {
      pots: pots, potsAtOwnRetire: ownRetirePots,
      gRatio: plan.gRatio, spendRed: plan.spendRed,
      startYear: startYr, retirementDate: baseRetire,
      retireByMember: retireByMember,
      tierDateOverrides: plan.tierDateOverrides || null,
      dynamic: !!plan.dynamic, gFloorPct: plan.gFloorPct || 0, jFloorPct: plan.jFloorPct || 0,
      savingsFundBills: plan.savingsFundBills,
      withdrawalMethod: { graham: plan.withdrawalMethodGraham || 'ufpls', julie: plan.withdrawalMethodJulie || 'ufpls' },
      crystallisationDate: {
        graham: plan.crystallisationDateGraham ? parseDate(plan.crystallisationDateGraham) : null,
        julie: plan.crystallisationDateJulie ? parseDate(plan.crystallisationDateJulie) : null
      },
      ufplsDivertTf: !!plan.ufplsDivertTf,
      sp: sp
    };
  }

  function closingFor(row, scope) {
    if (!row) return 0;
    if (scope === 'graham') return Number(row.g_closing) || 0;
    if (scope === 'julie') return Number(row.j_closing) || 0;
    return Number(row.combinedClosing != null ? row.combinedClosing : ((Number(row.g_closing) || 0) + (Number(row.j_closing) || 0))) || 0;
  }
  function buyFor(row, owner) {
    if (!row) return 0;
    if (owner === 'graham') return Number(row.g_annuityBuy) || 0;
    if (owner === 'julie') return Number(row.j_annuityBuy) || 0;
    return Number(row.annuityBuy) || 0;
  }
  function evaluateRows(rows, opts) {
    const monthly = rows && rows.monthly ? rows.monthly : [];
    const annIdx = opts.annuityDate ? monthIdx(opts.annuityDate) : null;
    let minPot = Infinity, minIdx = null, anyShortfall = false, annuityBuy = 0, lastRow = null;
    monthly.forEach(r => {
      const idx = r.year * 12 + r.month;
      const pot = closingFor(r, opts.reserveScope || 'combined');
      if (pot < minPot) { minPot = pot; minIdx = idx; }
      if (r.shortfall) anyShortfall = true;
      if (annIdx != null && idx === annIdx) annuityBuy += buyFor(r, opts.owner || 'graham');
      lastRow = r;
    });
    if (!Number.isFinite(minPot)) minPot = null;
    const reserveAmount = Number(opts.reserveAmount) || 0;
    const reserveOK = minPot == null ? true : minPot + 1e-6 >= reserveAmount;
    const shortfallOK = opts.noShortfall ? !anyShortfall : true;
    const annuityOK = opts.mustBuyAnnuity && opts.includeBestPlanAnnuity ? annuityBuy + 1 >= (Number(opts.annuityAmount) || 0) : true;
    let reason = 'Pass';
    if (!annuityOK) reason = 'Fixed annuity could not be bought at ' + dateLabel(opts.annuityDate) + '.';
    else if (!reserveOK) reason = 'Pot reserve breached: lowest ' + gbp(minPot) + ' is below ' + gbp(reserveAmount) + '.';
    else if (!shortfallOK) reason = 'At least one month has a shortfall.';
    return { pass: reserveOK && shortfallOK && annuityOK, reason, minPot, minPotIdx: minIdx, minPotDate: minIdx == null ? null : idxToDate(minIdx), anyShortfall, annuityBuy, endPot: lastRow ? closingFor(lastRow, opts.reserveScope || 'combined') : null, rows };
  }

  function findBestPlan(state, opts) {
    const minIdx = monthIdx(opts.minDate), maxIdx = monthIdx(opts.maxDate);
    if (maxIdx < minIdx) throw new Error('Latest date must be after earliest date.');
    let firstFail = null, tried = 0;
    for (let idx = minIdx; idx <= maxIdx; idx++) {
      tried++;
      const retireDate = idxToDate(idx);
      const plan = scenarioPlan(state, Object.assign({}, opts, { retirementDate: retireDate, retireByMember: null }));
      const runData = scenarioData(state, opts);
      const cfg = buildDrawdownCfg(state, runData, plan);
      const rows = PensionEngine.drawdown(runData, cfg);
      const ev = evaluateRows(rows, opts);
      if (ev.pass) return { feasible: true, earliestDate: retireDate, tried, detail: ev, plan, cfg, rows, opts };
      if (!firstFail) firstFail = ev;
    }
    return { feasible: false, tried, reason: firstFail ? firstFail.reason : 'No date in range passed.', firstFail, opts };
  }

  function runMss(state, opts) {
    if (!global.PensionOptimiser || !PensionOptimiser.maxSustainableSpend) throw new Error('PensionOptimiser.maxSustainableSpend is not loaded.');
    const plan = scenarioPlan(state, opts);
    const runData = scenarioData(state, opts);
    const cfg = buildDrawdownCfg(state, runData, plan);
    const res = PensionOptimiser.maxSustainableSpend(runData, cfg, {
      bridgePct: Number(opts.bridgePct) || 0,
      eolPct: Number(opts.eolPct) || 0,
      spendCap: Number(opts.spendCap) || 2,
      includeCrashes: !!opts.includeCrashes
    });
    if (res && res.feasible) {
      const rows = PensionEngine.drawdown(runData, Object.assign({}, cfg, { spendRed: res.maxSpendRed }));
      const ev = evaluateRows(rows, { reserveScope: 'combined', reserveAmount: 0, noShortfall: true });
      res.rows = rows; res.lowestPot = ev.minPot; res.lowestPotDate = ev.minPotDate; res.endPot = ev.endPot;
    }
    return res;
  }

  function runEra(state, opts) {
    if (!global.PensionOptimiser || !PensionOptimiser.earliestRetirement) throw new Error('PensionOptimiser.earliestRetirement is not loaded.');
    const runData = scenarioData(state, opts);
    const base = scenarioPlan(state, opts);
    const combine = opts.combineRetirement !== false;
    const p2Fixed = (!combine && state.basePlan && state.basePlan.retireByMember && state.p2Name) ? state.basePlan.retireByMember[state.p2Name] : null;
    const rebuildForDate = function (retireDate) {
      let rbm = null;
      if (state.p2Name && p2Fixed) { rbm = {}; if (state.p1Name) rbm[state.p1Name] = retireDate; rbm[state.p2Name] = p2Fixed; }
      const p = scenarioPlan(state, Object.assign({}, opts, { retirementDate: retireDate, retireByMember: rbm, spendRed: opts.spendRed }));
      return buildDrawdownCfg(state, runData, p);
    };
    return PensionOptimiser.earliestRetirement(runData, {
      rebuildForDate,
      minDate: parseDate(opts.minDate),
      maxDate: parseDate(opts.maxDate),
      who: opts.who || 'graham',
      nestEggFloor: Number(opts.nestEggFloor) || 0,
      includeCrashes: !!opts.includeCrashes
    });
  }

  global.BestPlanEngine = { BUILD, ANN_NAME, loadState, scenarioPlan, scenarioData, buildDrawdownCfg, findBestPlan, runMss, runEra, evaluateRows, parseDate, toInputDate, dateLabel, gbp };
})(typeof window !== 'undefined' ? window : globalThis);
