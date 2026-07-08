# LC-319 — Best Plan Finder v2

## Upload these files to the repo root

1. `app.html`
2. `best_plan_finder_addon.js`

## What changed from LC-318

Best Plan Finder now has explicit scenario inputs instead of inheriting everything silently from the current model.

New/changed controls:

- Withdrawal method:
  - Use current model settings
  - Force blended / UFPLS
  - Force tax-free first
  - Force flexi-access dates
- Existing annuities:
  - Exclude existing annuities
  - Include existing annuities
- Market crashes:
  - Include current crash table
  - Exclude crashes
- Best Plan annuity:
  - Include fixed Best Plan annuity
  - Exclude Best Plan annuity

Default behaviour:

- Existing annuities are excluded from the Best Plan test by default.
- The fixed Best Plan annuity is included by default.
- Market crashes are included by default.
- Withdrawal method defaults to the current model settings.

## Apply behaviour

`Apply to current model` now updates the in-browser current model only.

It does not write directly to Supabase.

It updates:

- The current retirement date slider.
- The in-memory annuity rows used by the model, based on the Best Plan scenario controls.
- The normal modelling charts.

The existing Save Model feature can then capture the applied scenario.

## Not changed

- `engine.js` unchanged.
- `optimiser.js` unchanged.
- `common.js` unchanged.
- SQL unchanged.
- Frame cache-buster unchanged.

## Validation performed

- JavaScript syntax check on `best_plan_finder_addon.js`.
- JavaScript syntax check on the inline script in `app.html`.

Live Supabase/browser behaviour still needs to be verified after upload.
