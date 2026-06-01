/* ============================================================
   engine.js  —  Pension modelling engine (pure JavaScript)

   This is the SAME maths that runs in the Scenario Lab, which was
   validated against the Supabase functions (calculate_joint_retirement
   and generate_monthly_pension_forecast). It is refactored here to be
   "pure": you pass data in, it returns results, with no global state —
   so every page can share one trustworthy copy.

   Two stages:
     PensionEngine.forecast(data, plan, contribMult)  -> {graham, julie}
        Accumulation: grows pots month-by-month to the retirement date.
     PensionEngine.drawdown(data, cfg)                -> [ yearRow, ... ]
        Retirement: year-by-year drawdown until end of life.

   "data" is an object of arrays loaded from Supabase:
     { members, bills, dining, guaranteed, pensions, logs, contributions }
   ============================================================ */
(function (global) {
  'use strict';

  // Assumptions inherited from the original engine so results match.
  const INFL = 0.025;     // inflation on outgoings & guaranteed income
  const GROWTH = 0.05;    // pot growth during the drawdown phase
  const PA = 12570;       // personal allowance (frozen)

  // ---- helpers ----
  function latestPots(data) {
    const map = {};
    (data.pensions || []).forEach(p => {
      let best = null;
      (data.logs || []).forEach(l => {
        if (l.member_name === p.member_name && l.pension_name === p.pension_name) {
          const t = new Date(l.log_date).getTime();
          if (best === null || t > best.t) best = { t, v: Number(l.pot_value) || 0 };
        }
      });
      map[p.member_name + '|' + p.pension_name] = best ? best.v : 0;
    });
    return map;
  }

  function sumMember(data, pots, who) {
    let s = 0;
    (data.pensions || []).forEach(p => {
      if (p.member_name === who) s += pots[p.member_name + '|' + p.pension_name] || 0;
    });
    return s;
  }

  // ---- ACCUMULATION: port of generate_monthly_pension_forecast ----
  // plan: { retirementDate, growthRate, phase1Date, phase1Days, phase2Date, phase2Days }
  function forecast(data, plan, contribMult) {
    if (contribMult == null) contribMult = 1;
    const pots = latestPots(data);
    const now = new Date();
    let cur = new Date(now.getFullYear(), now.getMonth() + 1, 1); // first of next month
    const retire = plan.retirementDate
      ? new Date(plan.retirementDate.getFullYear(), plan.retirementDate.getMonth(), 1)
      : new Date(cur.getFullYear() + 5, cur.getMonth(), 1);
    const monthlyGrowth = (plan.growthRate != null ? plan.growthRate : 0.05) / 12;
    let augusts = 0;

    let maxG = sumMember(data, pots, 'Graham');
    let maxJ = sumMember(data, pots, 'Julie');

    let guard = 0;
    while (cur < retire && guard < 1200) {
      guard++;
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);

      let gDays = 5;
      if (plan.phase2Date && cur >= plan.phase2Date) gDays = plan.phase2Days;
      else if (plan.phase1Date && cur >= plan.phase1Date) gDays = plan.phase1Days;

      if (cur.getMonth() === 7) augusts++; // August

      (data.contributions || []).forEach(c => {
        if (c.member_name === 'Graham' && Number(c.working_days) === Number(gDays)) {
          const k = 'Graham|' + c.pension_name;
          if (k in pots) pots[k] += (Number(c.monthly_contribution) || 0) * contribMult * Math.pow(1 + (Number(c.august_increase_pct) || 0), augusts);
        }
      });
      (data.contributions || []).forEach(c => {
        if (c.member_name === 'Julie') {
          const k = 'Julie|' + c.pension_name;
          if (k in pots) pots[k] += (Number(c.monthly_contribution) || 0) * contribMult * Math.pow(1 + (Number(c.august_increase_pct) || 0), augusts);
        }
      });

      Object.keys(pots).forEach(k => pots[k] *= (1 + monthlyGrowth));

      const g = sumMember(data, pots, 'Graham');
      const j = sumMember(data, pots, 'Julie');
      if (g > maxG) maxG = g;
      if (j > maxJ) maxJ = j;
    }
    return { graham: maxG, julie: maxJ };
  }

  // ---- DRAWDOWN: port of calculate_joint_retirement ----
  // cfg: { pots:{graham,julie}, gRatio, spendRed, startYear, retirementDate, sp }
  // sp:  { spRate, spDelay:{Graham,Julie}, meansTest:{enabled,threshold,taper}, stateNames:Set }
  function drawdown(data, cfg) {
    const gRatio = cfg.gRatio, spendRed = cfg.spendRed, jRatio = 1 - gRatio, sp = cfg.sp;
    const members = data.members || [], bills = data.bills || [], dining = data.dining || [], guaranteed = data.guaranteed || [];
    const gM = members.find(m => m.name === 'Graham') || {};
    const jM = members.find(m => m.name === 'Julie') || {};
    const gDobYr = gM.dob ? new Date(gM.dob).getFullYear() : null;
    const jDobYr = jM.dob ? new Date(jM.dob).getFullYear() : null;

    // Fraction of the FIRST calendar year spent in retirement.
    // Retire 1 Jan -> 1.0 (full year); retire 1 Dec -> ~1/12 (one month).
    // This removes the year-boundary "jump": a one-month change now moves
    // the projection by ~1/12, not by a whole drawdown year.
    let firstFrac = 1;
    if (cfg.retirementDate) {
      const rd = cfg.retirementDate;
      firstFrac = (12 - rd.getMonth()) / 12; // months remaining incl. the retirement month
      if (firstFrac <= 0 || firstFrac > 1) firstFrac = 1;
    }

    let endYr = Math.max(
      gM.end_of_life_date ? new Date(gM.end_of_life_date).getFullYear() : -Infinity,
      jM.end_of_life_date ? new Date(jM.end_of_life_date).getFullYear() : -Infinity
    );
    if (!isFinite(endYr) || endYr < cfg.startYear) endYr = cfg.startYear + 30;

    let gTf = cfg.pots.graham * 0.25, gTx = cfg.pots.graham * 0.75;
    let jTf = cfg.pots.julie * 0.25,  jTx = cfg.pots.julie * 0.75;

    // "elapsed" tracks real years since retirement (fractional in year one),
    // driving inflation continuously instead of in whole-year steps.
    let elapsed = 0, yr = 0;
    const rows = [];

    const taperFor = (row, oldest) => {
      if (oldest >= 90) return row.taper_at_90 != null ? Number(row.taper_at_90) : 1.0;
      if (oldest >= 80) return row.taper_at_80 != null ? Number(row.taper_at_80) : 1.0;
      if (oldest >= 70) return row.taper_at_70 != null ? Number(row.taper_at_70) : 1.0;
      return 1.0;
    };

    function grossFor(who, yearFrac) {
      if (yearFrac == null) yearFrac = 1;
      let stateGross = 0, otherGross = 0;
      guaranteed.filter(g => g.member_name === who).forEach(g => {
        if (!g.start_date) return;
        const isState = sp.stateNames.has(g.income_name);
        const delay = isState ? (sp.spDelay[who] || 0) : 0;
        const startYr = new Date(g.start_date).getFullYear() + delay;
        const endYrG = g.end_date ? new Date(g.end_date).getFullYear() : null;
        if (yr < startYr || (endYrG !== null && yr > endYrG)) return;
        const rate = isState ? sp.spRate : INFL;
        const val = (Number(g.initial_annual_value) || 0) * Math.pow(1 + rate, elapsed) * yearFrac;
        if (isState) stateGross += val; else otherGross += val;
      });
      return { stateGross, otherGross, total: stateGross + otherGross };
    }

    function drawFor(target, inc, tfPot, txPot) {
      const dbGross = inc.total;
      let dbNet, paRem;
      if (dbGross > PA) { dbNet = PA + (dbGross - PA) * 0.80; paRem = 0; }
      else { dbNet = dbGross; paRem = PA - dbGross; }
      let gap = Math.max(target - dbNet, 0);
      const drawTf = Math.min(gap, tfPot);
      const tfAfter = tfPot - drawTf;
      gap -= drawTf;
      let desiredGross = 0;
      if (gap > 0) desiredGross = (gap <= paRem) ? gap : paRem + (gap - paRem) / 0.80;
      const drawGross = Math.min(desiredGross, txPot);
      const txAfter = txPot - drawGross;
      const shortfall = desiredGross > txPot + 0.5;
      return { drawTf, drawGross, tfAfter, txAfter, shortfall, privateDraw: drawTf + drawGross };
    }

    function personYear(target, incRaw, tfPot, txPot) {
      const p1 = drawFor(target, incRaw, tfPot, txPot);
      let inc = incRaw;
      if (sp.meansTest && sp.meansTest.enabled && sp.meansTest.taper > 0 && incRaw.stateGross > 0) {
        const over = Math.max(0, p1.privateDraw - sp.meansTest.threshold);
        const reduction = Math.min(sp.meansTest.taper * over, incRaw.stateGross);
        if (reduction > 0) inc = { stateGross: incRaw.stateGross - reduction, otherGross: incRaw.otherGross, total: incRaw.total - reduction };
      }
      const p2 = drawFor(target, inc, tfPot, txPot);
      return Object.assign({}, p2, { inc: inc });
    }

    for (yr = cfg.startYear; yr <= endYr; yr++) {
      const gAge = gDobYr != null ? yr - gDobYr : 0;
      const jAge = jDobYr != null ? yr - jDobYr : 0;
      const oldest = Math.max(gAge, jAge);

      // fraction of THIS calendar year that is "in retirement" (year one may be partial)
      const yearFrac = (yr === cfg.startYear) ? firstFrac : 1;

      const gTfStart = gTf, gTxStart = gTx, jTfStart = jTf, jTxStart = jTx;

      const baseBills = bills.reduce((s, b) => s + (Number(b.total_annual) || 0) * (b.spend_reduction ? spendRed : 1.0) * taperFor(b, oldest), 0);
      const baseDining = dining.reduce((s, d) => s + (Number(d.annual_total) || 0) * (d.spend_reduction ? spendRed : 1.0) * taperFor(d, oldest), 0);

      const inflFactor = Math.pow(1 + INFL, elapsed);
      const billsTotal = baseBills * inflFactor * yearFrac;
      const diningTotal = baseDining * inflFactor * yearFrac;
      const yrOut = (baseBills + baseDining) * inflFactor * yearFrac;
      const gTarget = yrOut * gRatio, jTarget = yrOut * jRatio;

      const gRes = personYear(gTarget, grossFor('Graham', yearFrac), gTf, gTx);
      const jRes = personYear(jTarget, grossFor('Julie', yearFrac), jTf, jTx);

      gTf = gRes.tfAfter; gTx = gRes.txAfter;
      jTf = jRes.tfAfter; jTx = jRes.txAfter;

      const drawdownTot = gRes.drawTf + gRes.drawGross + jRes.drawTf + jRes.drawGross;
      const stateGross = gRes.inc.stateGross + jRes.inc.stateGross;
      const otherPensions = gRes.inc.total + jRes.inc.total;

      // growth applies only for the fraction of the year actually elapsed
      const grow = Math.pow(1 + GROWTH, yearFrac);
      gTf *= grow; gTx *= grow; jTf *= grow; jTx *= grow;

      rows.push({
        year: yr, gAge: gAge, jAge: jAge, outgoings: yrOut,
        billsTotal: billsTotal, diningTotal: diningTotal,
        gTarget: gTarget, jTarget: jTarget,
        taxFree: gTfStart + jTfStart, taxable: gTxStart + jTxStart,
        // per-person opening pots (handy for Graham/Julie views)
        g_taxFree: gTfStart, g_taxable: gTxStart, j_taxFree: jTfStart, j_taxable: jTxStart,
        stateGross: stateGross, otherPensions: otherPensions, drawdown: drawdownTot,
        g_other: gRes.inc.total, j_other: jRes.inc.total,
        g_draw: gRes.drawTf + gRes.drawGross, j_draw: jRes.drawTf + jRes.drawGross,
        g_income: gRes.inc.total + gRes.drawTf + gRes.drawGross,
        j_income: jRes.inc.total + jRes.drawTf + jRes.drawGross,
        totalIncome: otherPensions + drawdownTot,
        combinedClosing: gTf + gTx + jTf + jTx,
        g_closing: gTf + gTx, j_closing: jTf + jTx,
        shortfall: gRes.shortfall || jRes.shortfall
      });
      elapsed += yearFrac;
    }
    return rows;
  }

  // A no-risk state-pension config (baseline: everything inflates at 2.5%, no scenarios).
  function baselineSP(stateNames) {
    return { spRate: INFL, spDelay: { Graham: 0, Julie: 0 }, meansTest: { enabled: false, threshold: 0, taper: 0 }, stateNames: stateNames || new Set() };
  }

  global.PensionEngine = {
    INFL: INFL, GROWTH: GROWTH, PA: PA,
    latestPots: latestPots,
    forecast: forecast,
    drawdown: drawdown,
    baselineSP: baselineSP
  };

})(window);
