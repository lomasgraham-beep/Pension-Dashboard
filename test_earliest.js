/* Self-test for optimiser.js earliestRetirement() — runs against the REAL
   engine.js on a synthetic two-person fixture. Proves:
   - the rebuild->forecast->drawdown wiring is correct (field names),
   - feasibility is monotonic in the retirement date (later never fails
     after an earlier date passed),
   - the date bisection lands on the boundary month.

   The fixture is tuned so Graham's guaranteed income at SPA (state + a DB)
   comfortably exceeds household spend, so post-SPA the pot grows and the
   binding constraint is the BRIDGE LENGTH — giving a clean earliest age. */

globalThis.window = globalThis;            // shim so engine.js's IIFE (window) resolves
require('/mnt/project/engine.js');         // attaches PensionEngine
require('/mnt/user-data/outputs/optimiser.js'); // the NEW optimiser under test
const E = globalThis.PensionEngine;
const O = globalThis.PensionOptimiser;

const f = n => (n == null ? '   —   ' : '£' + Math.round(n).toLocaleString('en-GB'));
const ym = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');

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
    // DB pensions starting with state pension — sized so post-SPA guaranteed
    // income clears household spend and the pot grows after 2037, leaving the
    // BRIDGE LENGTH as the binding constraint for early retirement.
    { member_name: 'Graham', income_name: 'Final salary DB', start_date: '2037-06-01', initial_annual_value: 24000 },
    { member_name: 'Julie',  income_name: 'Final salary DB', start_date: '2037-03-01', initial_annual_value: 9000 }
  ],
  // Heavier spend so an early-retirement bridge (no guaranteed income before 2037)
  // genuinely threatens the pot, producing a non-trivial earliest-age boundary.
  bills: [
    { bill_name: 'Essentials', total_annual: 18000, spend_reduction: false },
    { bill_name: 'Lifestyle',  total_annual: 14000, spend_reduction: true }
  ],
  diningAnnual: 8000,
  crashes: [],
  savingsAccounts: [],
  purchases: [],
  incomeSources: [],
  incomeAmounts: []
};

const stateNames = new Set(data.guaranteed.map(x => x.income_name).filter(n => n && n.toLowerCase().includes('state')));
const basePlan = { growthRate: 0.05, gRatio: 0.5, spendRed: 1, dynamic: false, gFloorPct: 0, jFloorPct: 0 };

// rebuild a drawdown cfg for a candidate retirement date — mirrors app.html recomputeAll
// (calib = 1 in the test). Re-forecasts the pots for THAT date.
function rebuildForDate(retireDate) {
  const plan = Object.assign({}, basePlan, { retirementDate: retireDate, retireByMember: null });
  const js = E.forecast(data, plan, 1);
  const sp = E.baselineSP(stateNames);
  return {
    pots: { graham: js.graham, julie: js.julie },
    potsAtOwnRetire: { graham: js.potsAtOwnRetire.p1, julie: js.potsAtOwnRetire.p2 },
    gRatio: plan.gRatio, spendRed: plan.spendRed,
    startYear: retireDate.getFullYear(), retirementDate: retireDate,
    retireByMember: null, tierDateOverrides: null,
    dynamic: false, gFloorPct: 0, jFloorPct: 0, sp
  };
}

const who = 'graham';
const nestEggFloor = 0;
const minDate = new Date('2028-06-01');     // earliest you might retire
const maxDate = new Date('2037-06-01');     // = Graham's state pension date (no bridge)

// ---- 1) date sweep: show pot at SPA, pot at EoL, growth, pass/fail ----
console.log('Earliest-retirement sweep (who =', who + ', nest-egg floor =', f(nestEggFloor) + ', crashes off):');
console.log('retire   pass   potAtSPA    potAtEoL    growth(EoL-SPA)   shortfall');
const O2 = O;
let lastPass = false, monotonic = true;
for (let y = 2028; y <= 2037; y++) {
  const d = new Date(y + '-06-01');
  const r = O2._survivesAtDate(data, d, who, nestEggFloor, false, rebuildForDate);
  const e = r.ev;
  console.log(
    ym(d), '  ', (e.pass ? 'PASS' : 'fail'), ' ',
    f(e.potAtSPA).padStart(10), f(e.potAtEOL).padStart(11),
    f(e.growth).padStart(13), '     ', e.anyShortfall ? 'YES' : 'no'
  );
  if (e.pass && lastPass === false && y > 2028) { /* first pass after fails is fine */ }
  if (lastPass === true && !e.pass) monotonic = false;  // a fail AFTER a pass = non-monotonic
  lastPass = e.pass;
}
console.log('Monotonic (never fails at a later date after passing):', monotonic ? 'YES' : 'NO — PROBLEM');

// ---- 2) bisection result + boundary check ----
const res = O.earliestRetirement(data, {
  rebuildForDate, minDate, maxDate, who, nestEggFloor, includeCrashes: false
});
console.log('\nOptimiser result (crashes off):');
if (!res.feasible) {
  console.log('  NOT FEASIBLE —', res.reason, '(latest tried', ym(res.latestTried) + ')');
  console.log('    at latest date: potAtSPA', f(res.detail.potAtSPA), ' potAtEoL', f(res.detail.potAtEOL),
              ' shortfall', res.detail.anyShortfall);
} else {
  console.log('  Earliest retirement date:', ym(res.earliestDate),
              res.atRangeFloor ? '(= earliest allowed; could be earlier still)' : '',
              ' — bisection iters:', res.iterations);
  const e = res.detail;
  console.log('    Graham pot at SPA:', f(e.potAtSPA), ' at EoL:', f(e.potAtEOL),
              ' growth:', f(e.growth), ' (floorOK', e.floorOK + ', growOK', e.growOK + ')');
  // boundary check: the returned month passes; one month earlier must fail
  if (!res.atRangeFloor) {
    const oneEarlier = O._idxToDate(res.earliestIdx - 1);
    const rb = O._survivesAtDate(data, oneEarlier, who, nestEggFloor, false, rebuildForDate);
    console.log('  Boundary check: at result =', res.detail.pass ? 'PASS' : 'fail',
                '| one month earlier (' + ym(oneEarlier) + ') =', rb.pass ? 'PASS (PROBLEM)' : 'fail (correct)');
  }
}

// ---- 3) crashes-on toggle still runs ----
const resC = O.earliestRetirement(data, { rebuildForDate, minDate, maxDate, who, nestEggFloor, includeCrashes: true });
console.log('\nWith crashes on (none defined here, so identical):',
            resC.feasible ? ym(resC.earliestDate) : 'infeasible');
