/* ============================================================
   optimiser.js  —  Maximum Sustainable Spend (MSS) finder

   A PURE layer on top of PensionEngine. It does not touch the
   validated maths — it only re-runs PensionEngine.drawdown() with
   different spend multipliers and reads the output it already
   produces (per-month g_closing / j_closing and the shortfall flag).

   It finds the highest spending multiplier (spendRed) whose drawdown
   still "survives", where survives means ALL of:
     (a) no month is flagged shortfall;
     (b) for each person, the DC pot's LOWEST point during their own
         bridge (their retirement -> their own state-pension start)
         stays at or above a bridge floor (default 10% of starting pot);
     (c) each person's pot at their own end of life is at or above an
         end-of-life floor (default 10% of starting pot).

   Because spending more only ever worsens survival, the pass/fail
   boundary is a single threshold, so we BISECT one number.

   Usage (mirrors app.html recomputeAll — the caller builds the same
   cfg it already builds for drawdown, with pots/potsAtOwnRetire/sp etc.):

     const res = PensionOptimiser.maxSustainableSpend(data, baseCfg, {
       bridgePct: 0.10, eolPct: 0.10, includeCrashes: true
     });
   ============================================================ */
(function (global) {
  'use strict';

  function monthIdx(d) { d = new Date(d); return d.getFullYear() * 12 + d.getMonth(); }

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

  global.PensionOptimiser = {
    maxSustainableSpend: maxSustainableSpend,
    _resolveSlots: resolveSlots,
    _evaluate: evaluate,
    _survives: survives
  };

})(typeof window !== 'undefined' ? window : globalThis);
