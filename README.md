# LC-327 direct upload pack

Upload these files to the repository root:

1. `app.html`
2. `intelligent_modelling.html`
3. `best_plan_engine.js`

## Build labels

- `app.html`: LC-327
- `intelligent_modelling.html`: build im2
- `best_plan_engine.js`: bpe2

## What changed

- Adds sandbox result charts to Intelligent Modelling.
- Best Plan Finder, Maximum Sustainable Spend, and Earliest Retirement Age now show:
  - pot projection chart,
  - income/outgoings chart,
  - yearly output table.
- Charts are based only on the Intelligent Modelling sandbox run output.
- No Apply button.
- No Save.
- No Supabase writes.
- Main Modelling page remains divorced from Intelligent Modelling.

## Unchanged

- `engine.js`
- `optimiser.js`
- `common.js`
- SQL schema

After upload, hard refresh and confirm the app build stamp shows LC-327.
