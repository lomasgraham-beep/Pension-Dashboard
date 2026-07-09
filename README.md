# LC-328 Direct Upload Pack

Upload these files to the repo root:

- app.html
- intelligent_modelling.html
- best_plan_engine.js

## Changes

- Fixes/clarifies Tax Free First in Intelligent Modelling sandbox.
- Tax Free First now records the 25% PCLS event from the pension pot at the crystallisation/retirement month in the sandbox metadata.
- The pot projection chart now uses monthly output so the retirement-month PCLS deduction is visible instead of being hidden inside annual points.
- Pot projection chart now includes Surplus savings so the 25% tax-free cash can be seen leaving the DC pension pot and appearing outside the pension pot.
- Result cards show Tax-free cash taken when a PCLS event exists.
- Year table now includes Surplus savings.
- Main Modelling page remains divorced from Intelligent Modelling.

## Unchanged

- engine.js unchanged
- optimiser.js unchanged
- common.js unchanged
- No SQL changes
- No Supabase writes
- No Apply or Save feature

## Build labels

- app.html: LC-328
- intelligent_modelling.html: build im3
- best_plan_engine.js: bpe3
