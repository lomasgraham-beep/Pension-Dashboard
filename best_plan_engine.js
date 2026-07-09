/* ============================================================
   best_plan_engine.js — Intelligent Modelling sandbox controller
   build: bpe1 / target app build LC-326

   Uses the existing PensionEngine as the single source of pension maths.
   It never mutates the main Modelling page state and never writes to Supabase.
   ============================================================ */
(function (global) {
  'use strict';

  const BUILD = 'bpe1';
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

  async function loadState() {
    if (!global.App || !App.rest) throw new Error('App helpers are not loaded.');
    if (!global.PensionEngine) throw new Error('PensionEngine is not loaded.');
    const [members, bills, dining, guaranteed, pensions, contributions, logs, purchases, crashes, savingsAccounts, contributionExceptions, workingTiers, incomeSources, incomeAmounts, diningRota, mealCost, annuities] = await Promise.all([
      App.rest('bd_members'), App.rest('bd_household_bills'), App.rest('bd_dining_habits'),
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
      App.rest('bd_annuities?order=purchase_date.asc')
    ]);
    const mealCostMap = {};
    (mealCost || []).forEach(c => { mealCostMap[c.meal_type + '|' + c.level] = Number(c.cost) || 0; });
    const DAY_COLS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const diningAnnual = (diningRota || []).reduce((sum, r) => sum + DAY_COLS.reduce((s, col) => s + (r[col] ? (mealCostMap[r.meal_type + '|' + r[col]] || 0) : 0), 0), 0);
    const data = { members, bills, dining, diningAnnual, guaranteed, pensions, contributions, logs, purchases: purchases || [], crashes: crashes || [], savingsAccounts: savingsAccounts || [], contributionExceptions: contributionExceptions || [], workingTiers: workingTiers || [], incomeSources: incomeSources || [], incomeAmounts: incomeAmounts || [], annuities: annuities || [] };
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
