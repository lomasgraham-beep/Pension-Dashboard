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

  // ---- DRAWDOWN: monthly engine, aggregated to yearly rows ----
  // Calculates month-by-month (real cashflow): monthly outgoings, monthly income,
  // monthly drawdown to fill the net gap, monthly compounding growth, and tax on a
  // PAYE basis (1/12 of the personal allowance each month). Results are summed into
  // one row per calendar year so the table/charts are unchanged.
  // cfg: { pots:{graham,julie}, gRatio, spendRed, startYear, retirementDate, sp }
  function drawdown(data, cfg) {
    const gRatio = cfg.gRatio, spendRed = cfg.spendRed, jRatio = 1 - gRatio, sp = cfg.sp;
    const members = data.members || [], bills = data.bills || [], dining = data.dining || [], guaranteed = data.guaranteed || [];
    const gM = members.find(m => m.name === 'Graham') || {};
    const jM = members.find(m => m.name === 'Julie') || {};
    const gDobYr = gM.dob ? new Date(gM.dob).getFullYear() : null;
    const jDobYr = jM.dob ? new Date(jM.dob).getFullYear() : null;
    const gDob = gM.dob ? new Date(gM.dob) : null;
    const jDob = jM.dob ? new Date(jM.dob) : null;

    const MPA = PA / 12;                          // monthly personal allowance (PAYE-style)
    const mGrow = Math.pow(1 + GROWTH, 1 / 12);   // monthly growth so 12 months = the annual rate

    // Start at the actual retirement month; default to January of startYear.
    const rd = cfg.retirementDate || new Date(cfg.startYear, 0, 1);
    const startIdx = rd.getFullYear() * 12 + rd.getMonth();

    // The state pension figure is stored as TODAY'S value, so it must be grown from
    // now all the way to the claim date — i.e. an extra span on top of "elapsed since
    // retirement". This is that head-start span, in years, from this month to retirement.
    const nowMonth = new Date();
    const nowIdx = nowMonth.getFullYear() * 12 + nowMonth.getMonth();
    const preRetireYears = Math.max(0, (startIdx - nowIdx) / 12);

    // Run to the month of the latest end-of-life date (partial final year is fine).
    const gEol = gM.end_of_life_date ? new Date(gM.end_of_life_date) : null;
    const jEol = jM.end_of_life_date ? new Date(jM.end_of_life_date) : null;
    let endIdx = -Infinity;
    if (gEol) endIdx = Math.max(endIdx, gEol.getFullYear() * 12 + gEol.getMonth());
    if (jEol) endIdx = Math.max(endIdx, jEol.getFullYear() * 12 + jEol.getMonth());
    if (!isFinite(endIdx) || endIdx < startIdx) endIdx = startIdx + 30 * 12;

    let gTf = cfg.pots.graham * 0.25, gTx = cfg.pots.graham * 0.75;
    let jTf = cfg.pots.julie * 0.25,  jTx = cfg.pots.julie * 0.75;

    // ---- Cash savings pot (separate from pensions) ----
    // Seeds at start_balance at retirement; each month adds the saving then grows;
    // ---- Savings accounts (per member) ----
    // Each account grows by its own rule (monthly/annual/end-of-term, simple/compound), within its
    // contribution window, optionally escalating, optionally capped. Only instant-access accounts can
    // fund purchase deposits and the cap-redirect to living costs. cashBal (total) and per-member
    // totals are tracked for the table/charts.
    const savingsAccts = (data.savingsAccounts || []).map(a => {
      const cgrRaw = (a.contribution_growth_rate != null) ? Number(a.contribution_growth_rate) : 0;
      const cs = a.start_date ? new Date(a.start_date) : null;
      const ce = a.end_date ? new Date(a.end_date) : null;
      return {
        name: a.account_name, member: a.member_name,
        bal: Number(a.start_balance) || 0,
        monthly: Number(a.monthly_amount) || 0,
        cgr: cgrRaw > 1 ? cgrRaw / 100 : cgrRaw,         // tolerate decimal or percent
        cap: Number(a.savings_cap) || 0,                 // 0 = no cap
        aprM: (Number(a.apr) || 0) / 100 / 12,
        aprA: (Number(a.apr) || 0) / 100,
        freq: a.interest_frequency || 'monthly',
        simple: (a.interest_type === 'simple'),
        instant: (a.instant_access !== false),
        cStartIdx: cs ? cs.getFullYear() * 12 + cs.getMonth() : startIdx,
        cEndIdx: ce ? ce.getFullYear() * 12 + ce.getMonth() : Infinity,
        accruedSimple: 0,                                // running simple-interest accrual
        principalBase: Number(a.start_balance) || 0      // base for simple interest
      };
    });
    function totalCash() { return savingsAccts.reduce((s, a) => s + a.bal, 0); }
    function instantCash() { return savingsAccts.reduce((s, a) => s + (a.instant ? a.bal : 0), 0); }
    let cashBal = totalCash();   // kept for compatibility with existing per-row reporting
    // precompute purchases: month index of deposit, the deposit, and the monthly payment over its term
    const purchases = (data.purchases || []).map(p => {
      const d = p.purchase_date ? new Date(p.purchase_date) : null;
      const pIdx = d ? d.getFullYear() * 12 + d.getMonth() : null;
      const total = Number(p.total_cost) || 0, deposit = Number(p.deposit) || 0;
      const term = Math.round(Number(p.term_months) || 0);
      const financed = Math.max(0, total - deposit);
      const r = (Number(p.apr) || 0) / 100 / 12;
      let pay = 0;
      if (term > 0) pay = (r === 0) ? financed / term : financed * r / (1 - Math.pow(1 + r, -term));
      return { name: p.purchase_name, pIdx: pIdx, deposit: deposit, pay: pay, term: term };
    }).filter(p => p.pIdx != null);

    // ---- Market crashes (PruFund smoothed) ----
    // Each crash: starts at startIdx; pot falls by fall% over fallMonths to the trough,
    // then climbs back to the pre-crash value over recoveryMonths. During a crash window
    // the normal monthly growth is REPLACED by the crash trajectory factor; withdrawals
    // still happen, so a crash during drawdown erodes the pot faster (sequence risk).
    const crashes = (data.crashes || []).map(c => {
      const d = c.start_date ? new Date(c.start_date) : null;
      if (!d) return null;
      const startIdx = d.getFullYear() * 12 + d.getMonth();
      const F = Math.max(0, Math.min(0.99, (Number(c.fall_pct) || 0) / 100));
      const D = Math.max(1, Math.round(Number(c.fall_months) || 1));
      const R = Math.max(1, Math.round(Number(c.recovery_months) || 1));
      const fallStep = Math.pow(1 - F, 1 / D);            // compounded over D months = (1-F)
      const recoverStep = F < 1 ? Math.pow(1 / (1 - F), 1 / R) : 1; // climbs (1-F) back to 1.0 over R months
      return { startIdx, D, R, fallStep, recoverStep, endIdx: startIdx + D + R };
    }).filter(Boolean);
    // returns the growth factor to use THIS month if a crash is active, else null (use normal growth)
    function crashFactor(idx) {
      let factor = null;
      for (const c of crashes) {
        if (idx >= c.startIdx && idx < c.startIdx + c.D) { factor = (factor == null ? 1 : factor) * c.fallStep; }
        else if (idx >= c.startIdx + c.D && idx < c.endIdx) { factor = (factor == null ? 1 : factor) * c.recoverStep; }
      }
      return factor;
    }

    const taperFor = (row, oldest) => {
      if (oldest >= 90) return row.taper_at_90 != null ? Number(row.taper_at_90) : 1.0;
      if (oldest >= 80) return row.taper_at_80 != null ? Number(row.taper_at_80) : 1.0;
      if (oldest >= 70) return row.taper_at_70 != null ? Number(row.taper_at_70) : 1.0;
      return 1.0;
    };
    const ageAt = (dob, idx) => dob ? Math.floor((idx - (dob.getFullYear() * 12 + dob.getMonth())) / 12) : 0;

    // Monthly guaranteed income for one person, by actual start month.
    function grossMonth(who, idx, elapsed) {
      const elapsedYrs = Math.floor(elapsed);   // annual step: flat within each year since retirement
      let stateGross = 0, otherGross = 0;
      guaranteed.filter(g => g.member_name === who).forEach(g => {
        if (!g.start_date) return;
        const isState = sp.stateNames.has(g.income_name);
        const delay = isState ? (sp.spDelay[who] || 0) : 0;
        const sd = new Date(g.start_date);
        const sIdx = (sd.getFullYear() + delay) * 12 + sd.getMonth();
        let eIdx = Infinity;
        if (g.end_date) { const ed = new Date(g.end_date); eIdx = ed.getFullYear() * 12 + ed.getMonth(); }
        if (idx < sIdx || idx > eIdx) return;
        if (isState) {
          // stored as TODAY'S value → grow from now to this month (pre-retirement span + whole years since)
          const monthly = (Number(g.initial_annual_value) || 0) / 12 * Math.pow(1 + sp.spRate, Math.floor(preRetireYears + elapsed));
          stateGross += monthly;
        } else {
          // stored as value at retirement → grow only across whole years since retirement
          const monthly = (Number(g.initial_annual_value) || 0) / 12 * Math.pow(1 + INFL, elapsedYrs);
          otherGross += monthly;
        }
      });
      return { stateGross, otherGross, total: stateGross + otherGross };
    }

    // Floors (dynamic mode): each person's taxable pot is protected down to a % of
    // its value at retirement. Drawing stops at the floor and the unmet need is
    // redirected to the other person. If BOTH reach their floors, we draw below them.
    const gFloor = cfg.dynamic ? (cfg.gFloorPct || 0) * (cfg.pots.graham * 0.75) : 0;
    const jFloor = cfg.dynamic ? (cfg.jFloorPct || 0) * (cfg.pots.julie  * 0.75) : 0;

    // Fund one person's monthly net target from guaranteed income, then tax-free pot,
    // then taxable pot — but never taking the taxable pot below `txFloor`.
    function fundPerson(target, inc, tfPot, txPot, txFloor) {
      const dbGross = inc.total;
      let dbNet, paRem;
      if (dbGross > MPA) { dbNet = MPA + (dbGross - MPA) * 0.80; paRem = 0; }
      else { dbNet = dbGross; paRem = MPA - dbGross; }
      let netGap = Math.max(target - dbNet, 0);
      const drawTf = Math.min(netGap, tfPot);
      netGap -= drawTf;
      const txAvail = Math.max(txPot - txFloor, 0);
      let desiredGross = 0;
      if (netGap > 0) desiredGross = (netGap <= paRem) ? netGap : paRem + (netGap - paRem) / 0.80;
      const drawGross = Math.min(desiredGross, txAvail);
      const netFromTax = (drawGross <= paRem) ? drawGross : paRem + (drawGross - paRem) * 0.80;
      const unmetNet = Math.max(netGap - netFromTax, 0);
      return { drawTf, drawGross, tfAfter: tfPot - drawTf, txAfter: txPot - drawGross, unmetNet, inc };
    }

    // MANUAL mode: independent per person, no floor, no redistribution (with means test).
    function personManual(target, incRaw, tfPot, txPot) {
      const p1 = fundPerson(target, incRaw, tfPot, txPot, 0);
      let inc = incRaw;
      if (sp.meansTest && sp.meansTest.enabled && sp.meansTest.taper > 0 && incRaw.stateGross > 0) {
        const over = Math.max(0, (p1.drawTf + p1.drawGross) - (sp.meansTest.threshold / 12));
        const reduction = Math.min(sp.meansTest.taper * over, incRaw.stateGross);
        if (reduction > 0) inc = { stateGross: incRaw.stateGross - reduction, otherGross: incRaw.otherGross, total: incRaw.total - reduction };
      }
      const p2 = fundPerson(target, inc, tfPot, txPot, 0);
      return Object.assign({}, p2, { inc: inc, shortfall: p2.unmetNet > 1 });
    }

    // DYNAMIC mode: split by ratio, cap at floors, redirect a capped person's shortfall
    // to the other; returns the household residual still unfunded after redistribution.
    function allocate(gT, jT, gInc, jInc, tfG, txG, tfJ, txJ, fG, fJ) {
      let g = fundPerson(gT, gInc, tfG, txG, fG);
      let j = fundPerson(jT, jInc, tfJ, txJ, fJ);
      let residual = 0;
      if (g.unmetNet > 0.5) { j = fundPerson(jT + g.unmetNet, jInc, tfJ, txJ, fJ); residual = j.unmetNet; }
      else if (j.unmetNet > 0.5) { g = fundPerson(gT + j.unmetNet, gInc, tfG, txG, fG); residual = g.unmetNet; }
      return { g: g, j: j, residual: residual };
    }

    const rows = [];
    const monthlyRows = [];
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let acc = null, accYear = null;
    function flush() { if (acc) rows.push(acc); }

    for (let idx = startIdx; idx <= endIdx; idx++) {
      const yr = Math.floor(idx / 12);
      const elapsed = (idx - startIdx) / 12; // years since retirement (for inflation/growth)
      const gAge = ageAt(gDob, idx), jAge = ageAt(jDob, idx);
      const oldest = Math.max(gAge, jAge);

      // start a new yearly bucket when the calendar year changes
      if (yr !== accYear) {
        flush();
        accYear = yr;
        acc = {
          year: yr, gAge: gDobYr != null ? yr - gDobYr : 0, jAge: jDobYr != null ? yr - jDobYr : 0,
          outgoings: 0, billsTotal: 0, diningTotal: 0, gTarget: 0, jTarget: 0,
          taxFree: gTf + jTf, taxable: gTx + jTx,
          g_taxFree: gTf, g_taxable: gTx, j_taxFree: jTf, j_taxable: jTx,
          stateGross: 0, otherPensions: 0, drawdown: 0,
          g_other: 0, j_other: 0, g_draw: 0, j_draw: 0, g_income: 0, j_income: 0, totalIncome: 0,
          combinedClosing: 0, g_closing: 0, j_closing: 0, shortfall: false,
          cashBalance: 0, cashFinance: 0, cashDeposit: 0, cashShortfall: 0, cashCapDraw: 0
        };
      }

      const inflFactor = Math.pow(1 + INFL, Math.floor(elapsed));   // annual step: flat within each year since retirement
      const billsM = bills.reduce((s, b) => s + (Number(b.total_annual) || 0) * (b.spend_reduction ? spendRed : 1.0) * taperFor(b, oldest), 0) / 12 * inflFactor;
      const diningM = dining.reduce((s, d) => s + (Number(d.annual_total) || 0) * (d.spend_reduction ? spendRed : 1.0) * taperFor(d, oldest), 0) / 12 * inflFactor;

      // ---- Savings accounts for THIS month ----
      // For each account: add contribution (within its window) unless at its own cap (then withhold and
      // redirect to living costs); then apply interest per its frequency/type. Only instant-access
      // accounts can later fund deposits and redirect to bills.
      const cashOpen = totalCash();
      let capRedirectInstant = 0;          // withheld contributions from instant-access accounts (offset bills)
      for (const a of savingsAccts) {
        // contribution (escalated), within the contribution window
        if (idx >= a.cStartIdx && idx <= a.cEndIdx && a.monthly) {
          const saveThis = a.monthly * Math.pow(1 + a.cgr, Math.floor(elapsed));
          if (a.cap > 0 && a.bal >= a.cap) {
            // at this account's ceiling: withhold the contribution
            if (a.instant) capRedirectInstant += saveThis;   // only instant-access can offset bills
          } else {
            a.bal += saveThis; a.principalBase += saveThis;
          }
        }
        // interest by frequency / type
        if (a.simple) {
          a.accruedSimple += a.principalBase * a.aprM;
          const payNow = (a.freq === 'monthly') ||
                         (a.freq === 'annually' && (idx - startIdx + 1) % 12 === 0) ||
                         (a.freq === 'end_of_term' && idx === a.cEndIdx);
          if (payNow) { a.bal += a.accruedSimple; a.accruedSimple = 0; }
        } else {
          if (a.freq === 'monthly') a.bal *= (1 + a.aprM);
          else if (a.freq === 'annually' && (idx - startIdx + 1) % 12 === 0) a.bal *= (1 + a.aprA);
          else if (a.freq === 'end_of_term' && idx === a.cEndIdx) { const yrs = Math.max(0, (a.cEndIdx - a.cStartIdx + 1) / 12); a.bal *= Math.pow(1 + a.aprA, yrs); }
        }
      }

      // purchase deposits dated this month come from INSTANT-ACCESS accounts (proportionally);
      // shortfall spills to drawdown. finance payments for any purchase active this month.
      let depositThisMonth = 0, financeThisMonth = 0, depositShortfall = 0;
      for (const p of purchases) {
        if (p.pIdx === idx) depositThisMonth += p.deposit;
        if (idx >= p.pIdx && idx < p.pIdx + p.term) financeThisMonth += p.pay;
      }
      if (depositThisMonth > 0) {
        const avail = instantCash();
        const fromCash = Math.min(depositThisMonth, avail);
        // draw proportionally from instant-access accounts
        if (fromCash > 0 && avail > 0) {
          for (const a of savingsAccts) if (a.instant && a.bal > 0) a.bal -= fromCash * (a.bal / avail);
        }
        depositShortfall = depositThisMonth - fromCash;   // covered by pension drawdown this month
      }

      cashBal = totalCash();   // refresh the reported total after this month's account movements

      // finance payments + any deposit shortfall are extra outgoings the drawdown must cover;
      // withheld instant-access contributions reduce the cost the drawdown must cover.
      const cashOutM = financeThisMonth + depositShortfall;
      let outM = billsM + diningM + cashOutM;

      // Withheld contributions from instant-access accounts cover living costs, reducing drawdown
      // (capped so drawdown can't go below zero across the household).
      let capDrawFromSavings = 0;
      if (capRedirectInstant > 0) {
        capDrawFromSavings = Math.min(capRedirectInstant, outM);
        outM -= capDrawFromSavings;
      }

      const gTargetM = outM * gRatio, jTargetM = outM * jRatio;

      // opening pots for THIS month (before drawdown)
      const oGTf = gTf, oGTx = gTx, oJTf = jTf, oJTx = jTx;

      const gInc = grossMonth('Graham', idx, elapsed);
      const jInc = grossMonth('Julie', idx, elapsed);

      let gRes, jRes, monthShort;
      if (cfg.dynamic) {
        let a = allocate(gTargetM, jTargetM, gInc, jInc, gTf, gTx, jTf, jTx, gFloor, jFloor);
        if (a.residual > 0.5) {            // both at their floors → draw below the floors
          a = allocate(gTargetM, jTargetM, gInc, jInc, gTf, gTx, jTf, jTx, 0, 0);
        }
        gRes = a.g; jRes = a.j; monthShort = a.residual > 1; // genuine only if pots truly empty
      } else {
        gRes = personManual(gTargetM, gInc, gTf, gTx);
        jRes = personManual(jTargetM, jInc, jTf, jTx);
        monthShort = gRes.shortfall || jRes.shortfall;
      }

      gTf = gRes.tfAfter; gTx = gRes.txAfter; jTf = jRes.tfAfter; jTx = jRes.txAfter;

      // monthly growth on what remains — overridden by a crash trajectory if one is active
      const cf = crashFactor(idx);
      const gm = (cf != null) ? cf : mGrow;
      gTf *= gm; gTx *= gm; jTf *= gm; jTx *= gm;

      const gDraw = gRes.drawTf + gRes.drawGross, jDraw = jRes.drawTf + jRes.drawGross;
      const mState = gRes.inc.stateGross + jRes.inc.stateGross;
      const mOther = gRes.inc.total + jRes.inc.total;

      // one row for this single month (same field names as yearly rows)
      monthlyRows.push({
        year: yr, month: (idx % 12), label: MONTH_NAMES[idx % 12] + ' ' + yr,
        gAge: gAge, jAge: jAge,
        outgoings: outM, billsTotal: billsM, diningTotal: diningM, gTarget: gTargetM, jTarget: jTargetM,
        taxFree: oGTf + oJTf, taxable: oGTx + oJTx,
        g_taxFree: oGTf, g_taxable: oGTx, j_taxFree: oJTf, j_taxable: oJTx,
        stateGross: mState, otherPensions: mOther, drawdown: gDraw + jDraw,
        g_other: gRes.inc.total, j_other: jRes.inc.total, g_draw: gDraw, j_draw: jDraw,
        g_income: gRes.inc.total + gDraw, j_income: jRes.inc.total + jDraw,
        totalIncome: mOther + gDraw + jDraw,
        combinedClosing: gTf + gTx + jTf + jTx, g_closing: gTf + gTx, j_closing: jTf + jTx,
        shortfall: monthShort,
        cashBalance: cashBal, cashFinance: financeThisMonth, cashDeposit: depositThisMonth, cashShortfall: depositShortfall, cashCapDraw: capDrawFromSavings,
        acctBalances: savingsAccts.map(a => ({ name: a.name, member: a.member, bal: a.bal }))
      });

      acc.outgoings += outM; acc.billsTotal += billsM; acc.diningTotal += diningM;
      acc.gTarget += gTargetM; acc.jTarget += jTargetM;
      acc.stateGross += gRes.inc.stateGross + jRes.inc.stateGross;
      acc.g_other += gRes.inc.total; acc.j_other += jRes.inc.total;
      acc.otherPensions += gRes.inc.total + jRes.inc.total;
      acc.g_draw += gDraw; acc.j_draw += jDraw; acc.drawdown += gDraw + jDraw;
      acc.g_income += gRes.inc.total + gDraw; acc.j_income += jRes.inc.total + jDraw;
      acc.totalIncome += gRes.inc.total + jRes.inc.total + gDraw + jDraw;
      acc.combinedClosing = gTf + gTx + jTf + jTx;
      acc.g_closing = gTf + gTx; acc.j_closing = jTf + jTx;
      acc.cashBalance = cashBal;                     // year-end balance (last month wins)
      acc.cashCapDraw = (acc.cashCapDraw || 0) + capDrawFromSavings;
      acc.cashFinance += financeThisMonth;
      acc.cashDeposit += depositThisMonth;
      acc.cashShortfall += depositShortfall;
      if (monthShort) acc.shortfall = true;
    }
    flush();
    rows.monthly = monthlyRows;
    rows.savingsAccountList = savingsAccts.map(a => ({ name: a.name, member: a.member, instant: a.instant }));
    rows.crashWindows = crashes.map(c => ({ startIdx: c.startIdx, troughIdx: c.startIdx + c.D, endIdx: c.endIdx }));
    rows.purchaseWindows = purchases.map(p => ({ name: p.name, depositIdx: p.pIdx, payoffIdx: p.pIdx + p.term, term: p.term, deposit: p.deposit, pay: p.pay }));
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
