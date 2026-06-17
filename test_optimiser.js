/* Self-test for optimiser.js — runs against the REAL engine.js on a synthetic
   two-person fixture. Proves: the wiring to drawdown is correct (field names),
   survival is monotonic in spend, and the bisection lands on the boundary. */

globalThis.window = globalThis;            // shim so engine.js's IIFE (window) resolves
require('/mnt/project/engine.js');         // attaches PensionEngine
require('./optimiser.js');                 // attaches PensionOptimiser
const E = globalThis.PensionEngine;
const O = globalThis.PensionOptimiser;

const f = n => '£' + Math.round(n).toLocaleString('en-GB');

// ---- synthetic fixture (structurally like the Supabase data) ----
const data = {
  members: [
    { name: 'Graham', dob: '1968-06-01', end_of_life_date: '2050-06-01' },
    { name: 'Julie',  dob: '1970-03-01', end_of_life_date: '2055-03-01' }
  ],
  pensions: [
    { member_name: 'Graham', pension_name: 'DC1' },
    { member_name: 'Julie',  pension_name: 'DC1' }
  ],
  logs: [
    { member_name: 'Graham', pension_name: 'DC1', pot_value: 200000, log_date: '2026-05-01', contribution_applied: true },
    { member_name: 'Julie',  pension_name: 'DC1', pot_value: 150000, log_date: '2026-05-01', contribution_applied: true }
  ],
  contributions: [
    { member_name: 'Graham', pension_name: 'DC1', monthly_contribution: 500, working_days: 5, increase_month: 8, august_increase_pct: 0 },
    { member_name: 'Julie',  pension_name: 'DC1', monthly_contribution: 400, working_days: 5, increase_month: 8, august_increase_pct: 0 }
  ],
  workingTiers: [
    { member_name: 'Graham', days: 5, from_date: '2010-01-01' },
    { member_name: 'Julie',  days: 5, from_date: '2010-01-01' }
  ],
  contributionExceptions: [],
  guaranteed: [
    // state pensions (the bridge ends here), ~£11.5k each from 2037
    { member_name: 'Graham', income_name: 'State pension', start_date: '2037-06-01', initial_annual_value: 11500 },
    { member_name: 'Julie',  income_name: 'State pension', start_date: '2037-03-01', initial_annual_value: 11500 },
    // a DB pension for Graham, same time as his state pension
    { member_name: 'Graham', income_name: 'Final salary DB', start_date: '2037-06-01', initial_annual_value: 6000 }
  ],
  bills: [
    { bill_name: 'Essentials', total_annual: 9000, spend_reduction: false },
    { bill_name: 'Lifestyle',  total_annual: 6000, spend_reduction: true }
  ],
  diningAnnual: 4000,
  crashes: [],
  savingsAccounts: [],
  purchases: [],
  incomeSources: [],
  incomeAmounts: []
};

// ---- build baseCfg exactly the way app.html recomputeAll does ----
const plan = { retirementDate: new Date('2030-06-01'), growthRate: 0.05, gRatio: 0.5,
               spendRed: 1, dynamic: false, gFloorPct: 0, jFloorPct: 0 };
const js = E.forecast(data, plan, 1);
const stateNames = new Set(data.guaranteed.map(x => x.income_name).filter(n => n && n.toLowerCase().includes('state')));
const sp = E.baselineSP(stateNames);
const pots = { graham: js.graham, julie: js.julie };
const potsAtOwnRetire = { graham: js.potsAtOwnRetire.p1, julie: js.potsAtOwnRetire.p2 };
const baseCfg = {
  pots, potsAtOwnRetire, gRatio: plan.gRatio, spendRed: 1,
  startYear: 2030, retirementDate: plan.retirementDate, retireByMember: null,
  tierDateOverrides: null, dynamic: false, gFloorPct: 0, jFloorPct: 0, sp
};

console.log('Pots at retirement (2030):  Graham', f(potsAtOwnRetire.graham), '  Julie', f(potsAtOwnRetire.julie));
console.log('10% floors:                 Graham', f(0.10 * potsAtOwnRetire.graham), '  Julie', f(0.10 * potsAtOwnRetire.julie));

// ---- 1) monotonicity sweep ----
console.log('\nSpend sweep (crashes off) — pass requires no shortfall + both bridge & EoL floors met:');
console.log('spend  pass   G.trough   G.eol     J.trough   J.eol');
const sweep = [0, 0.5, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0];
let lastPass = true, monotonic = true;
for (const s of sweep) {
  const ev = O._survives(data, baseCfg, O._resolveSlots(data, baseCfg), s,
                         { bridgePct: 0.10, eolPct: 0.10, includeCrashes: false });
  const G = ev.people[0], J = ev.people[1];
  console.log(
    s.toFixed(2).padStart(4), '  ',
    (ev.pass ? 'PASS' : 'fail'), ' ',
    f(G.trough).padStart(9), f(G.eolVal).padStart(9), '  ',
    f(J.trough).padStart(9), f(J.eolVal).padStart(9)
  );
  if (ev.pass && !lastPass) monotonic = false;   // a pass after a fail = non-monotonic
  lastPass = ev.pass;
}
console.log('Monotonic (never passes at a higher spend after failing):', monotonic ? 'YES' : 'NO — PROBLEM');

// ---- 2) bisection result + boundary check ----
const res = O.maxSustainableSpend(data, baseCfg, { bridgePct: 0.10, eolPct: 0.10, includeCrashes: false });
console.log('\nOptimiser result (crashes off):');
if (!res.feasible) {
  console.log('  NOT FEASIBLE —', res.reason);
} else if (res.unbounded) {
  console.log('  Sustainable beyond the', res.maxSpendRed + 'x cap (pots over-funded).');
} else {
  console.log('  Max sustainable spend multiplier:', res.maxSpendRed.toFixed(3) + 'x',
              '(' + (res.maxSpendRed * 100).toFixed(1) + '% of planned discretionary)');
  console.log('  = ' + f(res.maxDiscMonthly) + '/month discretionary (today\'s money), bisection iters:', res.iterations);
  res.detail.people.forEach(p => {
    console.log('   ', p.name, ' bridge trough', f(p.trough), '(floor', f(p.bridgeFloor) + ')',
                ' | EoL', f(p.eolVal), '(floor', f(p.eolFloor) + ')');
  });
  // boundary check: the returned level passes, a hair above must fail
  const justAbove = O._survives(data, baseCfg, O._resolveSlots(data, baseCfg), res.maxSpendRed + 0.01,
                               { bridgePct: 0.10, eolPct: 0.10, includeCrashes: false });
  const atLevel = O._survives(data, baseCfg, O._resolveSlots(data, baseCfg), res.maxSpendRed,
                             { bridgePct: 0.10, eolPct: 0.10, includeCrashes: false });
  console.log('  Boundary check: at level =', atLevel.pass ? 'PASS' : 'fail',
              '| +0.01 above =', justAbove.pass ? 'PASS (PROBLEM)' : 'fail (correct)');
}

// ---- 3) crashes-on toggle still runs ----
const resC = O.maxSustainableSpend(data, baseCfg, { includeCrashes: true });
console.log('\nWith crashes on (none defined here, so identical):',
            resC.feasible ? (resC.maxSpendRed ? resC.maxSpendRed.toFixed(3) + 'x' : 'capped') : 'infeasible');
