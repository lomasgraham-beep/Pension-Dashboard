/* ============================================================
   optimiser.js  —  Maximum Sustainable Spend (MSS) finder
                    + Earliest Retirement Age (ERA) finder

   A PURE layer on top of PensionEngine. It does not touch the
   validated maths — it only re-runs PensionEngine.drawdown() (and,
   for ERA, PensionEngine.forecast() via a caller-supplied rebuild)
   with different inputs and reads the output the engine already
   produces (per-month g_closing / j_closing and the shortfall flag).

   ----------------------------------------------------------------
   1) maxSustainableSpend  — retirement date FIXED, bisect SPEND.
      Finds the highest spending multiplier (spendRed) whose drawdown
      still "survives", where survives means ALL of:
        (a) no month is flagged shortfall;
        (b) for each person, the DC pot's LOWEST point during their own
            bridge (their retirement -> their own state-pension start)
            stays at or above a bridge floor (default 10% of starting pot);
        (c) each person's pot at their own end of life is at or above an
            end-of-life floor (default 10% of starting pot).
      Spending more only ever worsens survival, so we BISECT one number.

   2) earliestRetirement  — spend FIXED, bisect the RETIREMENT DATE.
      Finds the EARLIEST retirement date for the target person at which
      their plan still "survives", where survives (for the target person)
      means ALL of:
        (a) no month is flagged shortfall (essentials always covered);
        (b) the target's DC pot never falls below the nest-egg floor (default £0)
            at ANY point in their retirement. The pot is typically U-shaped — drawn
            down well past state pension age, then recovering — so the floor is
            tested against the TRUE low point wherever it falls, NOT against the
            value at state pension age. floor £0 lets the pot run down toward zero
            at its trough (earliest possible date); raising the floor lifts the
            trough and pushes the date out, making the floor a real always-available
            reserve for the 80s/90s and large purchases.
      Retiring later means a bigger pot throughout and a shorter bridge, so the low
      point only rises with the date — feasibility is monotone and we BISECT one
      number, the month index.

      Unlike MSS, moving the retirement date changes the pot you retire
      WITH, so the caller must supply a rebuild callback that re-forecasts
      the pots for a candidate date and returns a drawdown cfg identical to
      the one app.html's recomputeAll builds:

        const res = PensionOptimiser.earliestRetirement(data, {
          rebuildForDate: (retireDate) => buildDrawdownCfg(retireDate),
          minDate: earliestSliderDate,   // Date or 'YYYY-MM-DD'
          maxDate: latestSliderDate,     // Date or 'YYYY-MM-DD'
          who: 'graham',                 // whose pot the floor test uses
          nestEggFloor: 0,               // £ minimum the pot may reach at any point
          includeCrashes: true
        });
   ============================================================ */
(function (global) {
  'use strict';

  function monthIdx(d) { d = new Date(d); return d.getFullYear() * 12 + d.getMonth(); }
  function idxToDate(idx) { return new Date(Math.floor(idx / 12), ((idx % 12) + 12) % 12, 1); }

  // Resolve the two engine "slots". The engine sorts members alphabetically and
  // maps member 1 -> the graham-key (g_closing) and member 2 -> the julie-key
  // (j_closing), regardless of the actual names. We mirror that exactly.
  function resolveSlots(data, baseCfg) {
    const members = (data.members || []).slice()
      .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
    const sp = baseCfg.sp || { stateNames: new Set(), spDelay: {} };
    const rbm = baseCfg.retireByMember || {};
    const fallbackRet = baseCfg.retirementDate
      ? monthIdx(baseCfg.retirementDate)
      : monthIdx(new Date((baseCfg.startYear || new Date().getFullYear()), 0, 1));

    function startsFor(name) {
      let stateIdx = null;
      const dbStarts = [];
      (data.guaranteed || []).forEach(function (g) {
        if (g.member_name !== name || !g.start_date) return;
        const isState = !!(sp.stateNames && sp.stateNames.has(g.income_name));
        const delay = isState ? ((sp.spDelay && sp.spDelay[name]) || 0) : 0;
        const sd = new Date(g.start_date);
        const idx = (sd.getFullYear() + delay) * 12 + sd.getMonth();
        if (isState) { if (stateIdx === null || idx < stateIdx) stateIdx = idx; }
        else dbStarts.push({ name: g.income_name, idx: idx });
      });
      return { stateIdx: stateIdx, dbStarts: dbStarts };
    }

    function slot(m, key) {
      if (!m) return null;
      const name = m.name;
      const st = startsFor(name);
      return {
        name: name,
        key: key,
        retIdx: (rbm[name] != null) ? monthIdx(rbm[name]) : fallbackRet,
        spaIdx: st.stateIdx,                 // bridge end = own state-pension start
        dbStarts: st.dbStarts,               // for the "DB starts elsewhere?" flag
        eolIdx: m.end_of_life_date ? monthIdx(m.end_of_life_date) : null,
        startPot: ((baseCfg.potsAtOwnRetire || baseCfg.pots || {})[key]) || 0
      };
    }
    return [slot(members[0], 'graham'), slot(members[1], 'julie')].filter(Boolean);
  }

  // Run the engine's drawdown at one spend level. Crashes off => run with an empty
  // crashes array (the only change), so the engine code path is otherwise identical.
  function runAt(data, baseCfg, spendRed, includeCrashes) {
    const cfg = Object.assign({}, baseCfg, { spendRed: spendRed });
    const runData = includeCrashes ? data : Object.assign({}, data, { crashes: [] });
    return global.PensionEngine.drawdown(runData, cfg);
  }

  // Apply the three-part survival test to a drawdown result.
  function evaluate(rows, slots, bridgePct, eolPct) {
    const monthly = rows.monthly || [];
    const ck = { graham: 'g_closing', julie: 'j_closing' };
    const byIdx = {};
    let anyShortfall = false;
    let lastIdx = -Infinity;
    monthly.forEach(function (r) {
      const idx = r.year * 12 + r.month;
      byIdx[idx] = r;
      if (idx > lastIdx) lastIdx = idx;
      if (r.shortfall) anyShortfall = true;
    });

    const people = slots.map(function (s) {
      const key = ck[s.key];

      // (b) bridge trough = lowest closing pot across [retire, own state-pension start]
      let trough = Infinity, troughIdx = null;
      if (s.spaIdx != null) {
        for (let i = s.retIdx; i <= s.spaIdx; i++) {
          const r = byIdx[i];
          if (!r) continue;
          if (r[key] < trough) { trough = r[key]; troughIdx = i; }
        }
      }
      if (!isFinite(trough)) trough = null;
      const bridgeFloor = bridgePct * s.startPot;
      const bridgeOK = (trough == null) ? true : (trough >= bridgeFloor - 1e-6);

      // (c) value at this person's own end of life (fall back to last month of the run)
      let eolVal = null;
      if (s.eolIdx != null) {
        const r = byIdx[s.eolIdx] || byIdx[lastIdx];
        if (r) eolVal = r[key];
      }
      const eolFloor = eolPct * s.startPot;
      const eolOK = (eolVal == null) ? true : (eolVal >= eolFloor - 1e-6);

      return {
        name: s.name, startPot: s.startPot,
        bridgeEndIdx: s.spaIdx, troughIdx: troughIdx,
        bridgeFloor: bridgeFloor, trough: trough, bridgeOK: bridgeOK,
        eolFloor: eolFloor, eolVal: eolVal, eolOK: eolOK,
        dbStarts: s.dbStarts
      };
    });

    const pass = !anyShortfall && people.every(function (p) { return p.bridgeOK && p.eolOK; });
    return { pass: pass, anyShortfall: anyShortfall, people: people };
  }

  function survives(data, baseCfg, slots, spendRed, o) {
    return evaluate(runAt(data, baseCfg, spendRed, o.includeCrashes), slots, o.bridgePct, o.eolPct);
  }

  function maxSustainableSpend(data, baseCfg, opts) {
    opts = opts || {};
    const o = {
      bridgePct: (opts.bridgePct != null) ? opts.bridgePct : 0.10,
      eolPct: (opts.eolPct != null) ? opts.eolPct : 0.10,
      includeCrashes: (opts.includeCrashes != null) ? opts.includeCrashes : true
    };
    const cap = (opts.spendCap != null) ? opts.spendCap : 5;
    const tol = (opts.tol != null) ? opts.tol : 0.001;   // spendRed precision

    const slots = resolveSlots(data, baseCfg);

    // discretionary base (today's £/month) purely for reporting the answer in £
    const billsRed = (data.bills || []).reduce(function (s, b) {
      return s + (b.spend_reduction ? (Number(b.total_annual) || 0) : 0);
    }, 0);
    const diningAnnual = (data.diningAnnual != null)
      ? (Number(data.diningAnnual) || 0)
      : (data.dining || []).reduce(function (s, d) { return s + (Number(d.annual_total) || 0); }, 0);
    const discMonthlyAt1 = (billsRed + diningAnnual) / 12;

    const base = {
      slots: slots, discMonthlyAt1: discMonthlyAt1,
      bridgePct: o.bridgePct, eolPct: o.eolPct, includeCrashes: o.includeCrashes
    };

    const atZero = survives(data, baseCfg, slots, 0, o);
    if (!atZero.pass) {
      return Object.assign({ feasible: false, reason: 'fails even at zero discretionary spend', detail: atZero }, base);
    }
    const atCap = survives(data, baseCfg, slots, cap, o);
    if (atCap.pass) {
      return Object.assign({
        feasible: true, unbounded: true, capped: true, maxSpendRed: cap,
        maxDiscMonthly: discMonthlyAt1 * cap, detail: atCap
      }, base);
    }

    // bisection: 0 passes, cap fails -> squeeze the boundary
    let lo = 0, hi = cap, lastPass = atZero, iters = 0;
    while (hi - lo > tol) {
      const mid = (lo + hi) / 2;
      const r = survives(data, baseCfg, slots, mid, o);
      if (r.pass) { lo = mid; lastPass = r; } else { hi = mid; }
      iters++;
    }
    return Object.assign({
      feasible: true, unbounded: false, maxSpendRed: lo,
      maxDiscMonthly: discMonthlyAt1 * lo, detail: lastPass, iterations: iters
    }, base);
  }

  /* ============================================================
     EARLIEST RETIREMENT AGE  (spend fixed, bisect the date)
     ============================================================ */

  // Survival test for the EARLIEST-retirement question, applied to ONE target
  // person: essentials covered everywhere (no shortfall), AND the target's DC pot
  // never falls below the nest-egg floor at ANY point in their retirement. The
  // pot is typically U-shaped (drawn down well past state pension age, then it
  // recovers), so the floor is tested against the TRUE low point — wherever it
  // falls — not against the value at state pension age. potAtSPA / potAtEOL are
  // kept for reporting only. Household no-shortfall uses every month's flag, so
  // the other person can't quietly fail.
  function evaluateEarliest(rows, slots, who, nestEggFloor) {
    const monthly = rows.monthly || [];
    const ck = { graham: 'g_closing', julie: 'j_closing' };
    const byIdx = {};
    let anyShortfall = false, lastIdx = -Infinity;
    monthly.forEach(function (r) {
      const idx = r.year * 12 + r.month;
      byIdx[idx] = r;
      if (idx > lastIdx) lastIdx = idx;
      if (r.shortfall) anyShortfall = true;
    });

    const target = slots.filter(function (s) { return s.key === who; })[0] || slots[0] || null;
    const TOL = 1e-6;

    let potAtSPA = null, potAtEOL = null, minPot = null, minPotIdx = null;
    let spaIdx = null, eolIdx = null, retIdx = null, name = null, startPot = null;
    if (target) {
      const key = ck[target.key];
      name = target.name; spaIdx = target.spaIdx; eolIdx = target.eolIdx; retIdx = target.retIdx; startPot = target.startPot;
      if (spaIdx != null && byIdx[spaIdx]) potAtSPA = byIdx[spaIdx][key];
      const endIdx = (eolIdx != null) ? eolIdx : lastIdx;
      if (eolIdx != null) { const r = byIdx[eolIdx] || byIdx[lastIdx]; if (r) potAtEOL = r[key]; }
      // lowest pot across the target's whole retirement: own retirement -> own end of life
      let fromIdx = (retIdx != null) ? retIdx : (monthly.length ? (monthly[0].year * 12 + monthly[0].month) : null);
      if (fromIdx != null) {
        for (let i = fromIdx; i <= endIdx; i++) {
          const r = byIdx[i];
          if (!r) continue;
          const v = r[key];
          if (minPot == null || v < minPot) { minPot = v; minPotIdx = i; }
        }
      }
    }

    const floorOK = (minPot == null) ? true : (minPot >= (nestEggFloor || 0) - TOL);
    const pass = !anyShortfall && floorOK;

    return {
      pass: pass, anyShortfall: anyShortfall,
      who: name, startPot: startPot, spaIdx: spaIdx, eolIdx: eolIdx, retIdx: retIdx,
      potAtSPA: potAtSPA, potAtEOL: potAtEOL,
      minPot: minPot, minPotIdx: minPotIdx,
      minPotYear: (minPotIdx != null) ? Math.floor(minPotIdx / 12) : null,
      nestEggFloor: (nestEggFloor || 0), floorOK: floorOK
    };
  }

  // Build the cfg for a candidate date (via the caller's rebuild), run drawdown,
  // resolve slots for THAT date's pots, and apply the earliest-survival test.
  function survivesAtDate(data, retireDate, who, nestEggFloor, includeCrashes, rebuildForDate) {
    const baseCfg = rebuildForDate(retireDate);
    const runData = includeCrashes ? data : Object.assign({}, data, { crashes: [] });
    const rows = global.PensionEngine.drawdown(runData, baseCfg);
    const slots = resolveSlots(data, baseCfg);
    const ev = evaluateEarliest(rows, slots, who, nestEggFloor);
    return { pass: ev.pass, ev: ev, baseCfg: baseCfg };
  }

  function earliestRetirement(data, opts) {
    opts = opts || {};
    if (typeof opts.rebuildForDate !== 'function') {
      throw new Error('earliestRetirement requires opts.rebuildForDate(retireDate) -> drawdown cfg');
    }
    const who = opts.who || 'graham';
    const nestEggFloor = (opts.nestEggFloor != null) ? opts.nestEggFloor : 0;
    const includeCrashes = (opts.includeCrashes != null) ? opts.includeCrashes : true;
    if (opts.minDate == null || opts.maxDate == null) {
      throw new Error('earliestRetirement requires minDate and maxDate (the slider range)');
    }
    const minIdx = monthIdx(opts.minDate);
    const maxIdx = monthIdx(opts.maxDate);
    if (maxIdx < minIdx) throw new Error('earliestRetirement: maxDate must be >= minDate');

    const base = { who: who, nestEggFloor: nestEggFloor, includeCrashes: includeCrashes,
                   minDate: idxToDate(minIdx), maxDate: idxToDate(maxIdx) };

    function at(idx) {
      return survivesAtDate(data, idxToDate(idx), who, nestEggFloor, includeCrashes, opts.rebuildForDate);
    }

    // Retiring as late as allowed is the easiest case. If even that fails,
    // there is no feasible retirement date inside the range.
    const atMax = at(maxIdx);
    if (!atMax.pass) {
      return Object.assign({ feasible: false,
        reason: 'fails even at the latest allowed retirement date',
        detail: atMax.ev, latestTried: idxToDate(maxIdx) }, base);
    }

    // If the earliest allowed date already passes, retire as early as you like.
    const atMin = at(minIdx);
    if (atMin.pass) {
      return Object.assign({ feasible: true, atRangeFloor: true,
        earliestIdx: minIdx, earliestDate: idxToDate(minIdx),
        detail: atMin.ev, iterations: 0 }, base);
    }

    // Bisect months: lo fails, hi passes -> smallest passing month index.
    let lo = minIdx, hi = maxIdx, lastPass = atMax, iters = 0;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const r = at(mid);
      if (r.pass) { hi = mid; lastPass = r; } else { lo = mid; }
      iters++;
    }
    return Object.assign({ feasible: true, atRangeFloor: false,
      earliestIdx: hi, earliestDate: idxToDate(hi),
      detail: lastPass.ev, iterations: iters }, base);
  }

  global.PensionOptimiser = {
    maxSustainableSpend: maxSustainableSpend,
    earliestRetirement: earliestRetirement,
    _resolveSlots: resolveSlots,
    _evaluate: evaluate,
    _survives: survives,
    _evaluateEarliest: evaluateEarliest,
    _survivesAtDate: survivesAtDate,
    _idxToDate: idxToDate,
    _monthIdx: monthIdx
  };

})(typeof window !== 'undefined' ? window : globalThis);
