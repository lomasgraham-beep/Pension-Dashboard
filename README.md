# LC-320 — Best Plan Finder v2 visibility fix

## Upload this file to the repo root

1. `app.html`

## What changed from LC-319

- Best Plan Finder v2 is now embedded directly inside `app.html`.
- `app.html` no longer depends on `best_plan_finder_addon.js` loading separately.
- This fixes the issue where Best Plan Finder disappeared if the add-on file was missing, stale, cached, or uploaded from the wrong link.
- Visible build stamp is now `LC-320`.

## What remains unchanged

- `engine.js` unchanged.
- `optimiser.js` unchanged.
- `common.js` unchanged.
- SQL unchanged.
- Existing saved-model workflow unchanged.

## Best Plan Finder behaviour

Best Plan Finder still provides explicit scenario controls for:

- Withdrawal method.
- Existing annuities include/exclude.
- Best Plan annuity include/exclude.
- Market crashes include/exclude.
- Fixed annuity amount, date, rate and escalation.

`Apply to current model` updates the current in-browser model only. Use the existing Save Model feature afterwards if happy.
