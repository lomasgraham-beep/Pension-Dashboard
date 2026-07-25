/* ============================================================
   regression.js — engine.js golden-master regression test  (build reg1)

   Purpose: one command that proves an engine.js edit did (or did not)
   change any number, replacing hand-built inertness proofs.

   Usage (Node, from the repo root — no dependencies):
       node regression.js            -> compare engine.js output to golden.json
       node regression.js --update   -> (re)write golden.json from current engine.js

   Workflow for an engine change:
     1. BEFORE editing:  node regression.js --update      (golden = old behaviour)
     2. Edit engine.js with the new feature GATED OFF (flag false / field absent).
     3. node regression.js                                -> must report 0 differences.
     4. Turn the flag on, re-run: differences now listed are exactly the
        intended change — review them, then --update to adopt as the new golden.

   The clock is FROZEN (below) so results never drift month to month; the
   synthetic dataset is fixed in absolute dates for the same reason. This file
   and golden.json live in the repo alongside engine.js.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---- frozen clock: the engine calls `new Date()`; pin "now" so goldens are stable ---- */
const RealDate = Date;
const FIXED = new RealDate(2026, 6, 1); // 1 July 2026 — never change, or regenerate golden.json
class FrozenDate extends RealDate {
  constructor(...args) { if (args.length === 0) { super(FIXED.getTime()); } else { super(...args); } }
  static now() { return FIXED.getTime(); }
}

/* ---- load engine.js in a sandbox with the frozen Date ---- */
const enginePath = path.join(__dirname, 'engine.js');
const src = fs.readFileSync(enginePath, 'utf8');
const sandbox = {};
new Function('window', 'Date', src)(sandbox, FrozenDate);
const E = sandbox.PensionEngine;
if (!E) { console.error('engine.js did not attach PensionEngine'); process.exit(2); }

/* ---- fixed synthetic dataset (absolute dates; exercises every engine feature) ---- */
function d(y, m) { return y + '-' + String(m).padStart(2, '0') + '-01'; }
const data = {
  members: [
    { name: 'Graham', dob: '1965-03-15', end_of_life_date: '2058-06-01' },
    { name: 'Julie',  dob: '1967-09-02', end_of_life_date: '2060-06-01' }
  ],
  bills: [
    { bill_name: 'Council tax', frequency: 'Monthly', premium: 210, total_annual: 2520, pay_months: '111111111100', spend_reduction: false },
    { bill_name: 'Energy', frequency: 'Monthly', premium: 180, total_annual: 2160, pay_months: '111111111111', spend_reduction: false },
    { bill_name: 'Groceries', frequency: 'Weekly', premium: 120, total_annual: 6240, spend_reduction: true, taper_at_70: 0.9, taper_at_80: 0.8, taper_at_90: 0.7 },
    { bill_name: 'Broadband', frequency: 'Monthly', premium: 35, total_annual: 420, pay_months: null, spend_reduction: false },
    { bill_name: 'Insurance', frequency: 'Annual', premium: 640, total_annual: 640, spend_reduction: false }
  ],
  dining: [ { dining_name: 'Legacy dining', annual_total: 2400, spend_reduction: true, taper_at_70: 0.9 } ],
  diningAnnual: 3120,
  diningTaper: { taper_at_70: 0.9, taper_at_80: 0.75, taper_at_90: 0.6 },
  holidayAnnual: 5200,
  holidayTaper: { taper_at_70: 0.85, taper_at_80: 0.6, taper_at_90: 0.4 },
  guaranteed: [
    { member_name: 'Graham', income_name: 'State Pension', initial_annual_value: 11970, start_date: '2032-04-01' },
    { member_name: 'Julie',  income_name: 'State Pension', initial_annual_value: 11500, start_date: '2034-10-01' },
    { member_name: 'Graham', income_name: 'DB scheme', initial_annual_value: 4200, start_date: '2030-01-01', escalation_pct: 3.0 },
    { member_name: 'Julie',  income_name: 'Small DB', initial_annual_value: 1800, start_date: '2031-01-01', end_date: '2041-01-01', escalation_pct: 0 }
  ],
  pensions: [
    { member_name: 'Graham', pension_name: 'Pru Personal', is_workplace: false, active: true },
    { member_name: 'Graham', pension_name: 'Work DC', is_workplace: true, active: true },
    { member_name: 'Julie',  pension_name: 'Pru Personal J', is_workplace: false, active: true },
    { member_name: 'Julie',  pension_name: 'Old pot', active: false }
  ],
  logs: [
    { member_name: 'Graham', pension_name: 'Pru Personal', log_date: '2026-05-01', pot_value: 180000 },
    { member_name: 'Graham', pension_name: 'Work DC', log_date: '2026-05-01', pot_value: 240000 },
    { member_name: 'Julie',  pension_name: 'Pru Personal J', log_date: '2026-05-01', pot_value: 150000 },
    { member_name: 'Julie',  pension_name: 'Old pot', log_date: '2025-01-01', pot_value: 999999 }
  ],
  contributions: [
    { member_name: 'Graham', pension_name: 'Pru Personal', working_days: 5, monthly_contribution: 400, august_increase_pct: 0.03, increase_month: 8 },
    { member_name: 'Graham', pension_name: 'Work DC', working_days: 5, monthly_contribution: 600, august_increase_pct: 0.02, increase_month: 4 },
    { member_name: 'Graham', pension_name: 'Pru Personal', working_days: 3, monthly_contribution: 150, august_increase_pct: 0, increase_month: 8 },
    { member_name: 'Julie', pension_name: 'Pru Personal J', working_days: 5, monthly_contribution: 300, august_increase_pct: 0.03, increase_month: 8 }
  ],
  contributionExceptions: [
    { member_name: 'Graham', pension_name: 'Pru Personal', contribution_value: 250, one_off: false, start_date: '2027-01-01', end_date: '2027-06-01' },
    { member_name: 'Julie', pension_name: 'Pru Personal J', contribution_value: 5000, one_off: true, start_date: '2027-03-01' }
  ],
  workingTiers: [
    { member_name: 'Graham', days: 5, from_date: '2016-01-01' },
    { member_name: 'Graham', days: 3, from_date: '2028-04-01' },
    { member_name: 'Julie', days: 5, from_date: '2016-01-01' }
  ],
  incomeSources: [
    { member_name: 'Graham', source_name: 'Salary', award_pct: 0.03, award_month: 4 },
    { member_name: 'Julie', source_name: 'Salary', award_pct: 0.02, award_month: 4 }
  ],
  incomeAmounts: [
    { member_name: 'Graham', source_name: 'Salary', working_days: 5, net_monthly: 2900 },
    { member_name: 'Graham', source_name: 'Salary', working_days: 3, net_monthly: 1800 },
    { member_name: 'Julie', source_name: 'Salary', working_days: 5, net_monthly: 2400 }
  ],
  savingsAccounts: [
    { account_name: 'Instant G', member_name: 'Graham', start_balance: 15000, monthly_amount: 200, apr: 4.1, interest_frequency: 'monthly', interest_type: 'compound', instant_access: true, contribution_growth_rate: 2.0, savings_cap: 30000, start_date: '2026-01-01' },
    { account_name: 'Fix J', member_name: 'Julie', start_balance: 20000, monthly_amount: 0, apr: 4.5, interest_frequency: 'end_of_term', interest_type: 'simple', instant_access: false, start_date: '2026-01-01', end_date: '2033-01-01' },
    { account_name: 'Annual G', member_name: 'Graham', start_balance: 5000, monthly_amount: 100, apr: 3.8, interest_frequency: 'annually', interest_type: 'compound', instant_access: true }
  ],
  purchases: [
    { purchase_name: 'Car', purchase_date: '2031-06-01', total_cost: 24000, deposit: 8000, term_months: 36, apr: 6.9 },
    { purchase_name: 'Roof', purchase_date: '2035-03-01', total_cost: 12000, deposit: 12000, term_months: 0, apr: 0 }
  ],
  annuities: [
    { annuity_name: 'G annuity', member_name: 'Graham', purchase_date: '2036-01-01', purchase_amount: 60000, annuity_rate: 6.2, escalation_pct: 3.0, enabled: true },
    { annuity_name: 'Disabled', member_name: 'Julie', purchase_date: '2037-01-01', purchase_amount: 40000, annuity_rate: 5.5, escalation_pct: 0, enabled: false }
  ],
  crashes: [
    { crash_name: 'Early crash', start_date: '2031-02-01', fall_pct: 20, fall_months: 10, recovery_months: 26 },
    { crash_name: 'Late crash', start_date: '2040-08-01', fall_pct: 12, fall_months: 6, recovery_months: 18 }
  ]
};

/* ---- plan / cfg matrix (kept in lockstep with the LC-383 proof harness) ---- */
function mkSP(over) {
  const sp = E.baselineSP(new Set(['State Pension']));
  return Object.assign(sp, over || {});
}
const R4 = new FrozenDate(2030, 3, 1);
const plans = [
  { name: 'base', plan: { retirementDate: R4, growthRate: 0.05 } },
  { name: 'growth4-tiers', plan: { retirementDate: R4, growthRate: 0.04,
      retireByMember: { Graham: R4, Julie: new FrozenDate(2032, 9, 1) } } },
  { name: 'privContrib', plan: { retirementDate: R4, growthRate: 0.05, privContrib: { Graham: 700, Julie: 500 } } },
  { name: 'near', plan: { retirementDate: new FrozenDate(2026, 11, 1), growthRate: 0.06 } }
];
function cfgVariants(plan, pots) {
  const base = {
    pots, potsAtOwnRetire: pots, gRatio: 0.55, spendRed: 1.0,
    startYear: plan.retirementDate.getFullYear(), retirementDate: plan.retirementDate,
    retireByMember: plan.retireByMember || null, sp: mkSP()
  };
  return [
    ['ufpls', Object.assign({}, base)],
    ['ufpls-growth3', Object.assign({}, base, { growthRate: 0.03 })],
    ['spendRed85-dyn', Object.assign({}, base, { spendRed: 0.85, dynamic: true, gFloorPct: 0.25, jFloorPct: 0.25 })],
    ['fad-divert', Object.assign({}, base, {
      withdrawalMethod: { graham: 'fad', julie: 'ufpls' },
      crystallisationDate: { graham: new FrozenDate(2031, 0, 1), julie: null },
      ufplsDivertTf: true })],
    ['noSavBills-meansTest-delay', Object.assign({}, base, {
      savingsFundBills: false,
      sp: mkSP({ spDelay: { Graham: 1, Julie: 2 }, meansTest: { enabled: true, threshold: 24000, taper: 0.5 } }) })]
  ];
}

/* ---- run the matrix, collect a flat map of every numeric leaf ---- */
const out = {};
function record(prefix, obj) {
  if (typeof obj === 'number') { out[prefix] = Number.isFinite(obj) ? Number(obj.toPrecision(12)) : String(obj); return; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => record(prefix + '[' + i + ']', v)); return; }
  if (obj && typeof obj === 'object') { for (const k of Object.keys(obj).sort()) record(prefix + '.' + k, obj[k]); return; }
  out[prefix] = String(obj);
}
for (const { name, plan } of plans) {
  for (const cm of [1, 0.5]) {
    const fc = E.forecast(data, plan, cm);
    record('forecast:' + name + ':cm' + cm, fc);
    const pots = { graham: fc.graham, julie: fc.julie };
    for (const [vn, cfg] of cfgVariants(plan, pots)) {
      record('drawdown:' + name + ':cm' + cm + ':' + vn, E.drawdown(data, cfg));
    }
  }
}

/* ---- compare / update golden ---- */
const goldenPath = path.join(__dirname, 'golden.json');
if (process.argv.includes('--update')) {
  fs.writeFileSync(goldenPath, JSON.stringify(out));
  console.log('golden.json written: ' + Object.keys(out).length + ' fields');
  process.exit(0);
}
if (!fs.existsSync(goldenPath)) {
  console.error('No golden.json — run `node regression.js --update` first (against the KNOWN-GOOD engine).');
  process.exit(2);
}
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
const keys = new Set([...Object.keys(golden), ...Object.keys(out)]);
let diffs = 0; const sample = [];
for (const k of keys) {
  if (golden[k] !== out[k]) { diffs++; if (sample.length < 15) sample.push(k + ': golden ' + golden[k] + ' -> now ' + out[k]); }
}
console.log(keys.size + ' fields compared, ' + diffs + ' differences');
if (diffs) { console.log(sample.join('\n')); if (diffs > 15) console.log('... and ' + (diffs - 15) + ' more'); process.exit(1); }
console.log('REGRESSION PASS — engine output matches golden.json');
