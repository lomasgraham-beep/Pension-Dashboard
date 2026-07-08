# LC-322 — Best Plan Finder layout refinement

Upload only `app.html` to the repository root.

## Purpose

This is a layout-only refinement of the LC-321 Best Plan Finder.

## Changes

- Keeps Best Plan Finder embedded directly in `app.html`.
- No separate `best_plan_finder_addon.js` is required.
- Moves Best Plan Finder into a MacBook-friendly two-column layout:
  - scenario/rule inputs on the left;
  - result panel on the right.
- Collapses Scenario Inputs by default into a compact summary row.
- Keeps iPad/iPhone stacked layout.
- Adds clearer reserve headroom in the pass result.
- Adds an applied-changes summary after pressing Apply.

## Unchanged

- `engine.js` unchanged.
- `optimiser.js` unchanged.
- `common.js` unchanged.
- SQL unchanged.
- Existing Save Model flow unchanged.

## Upload

1. Upload `app.html` to the repo root, replacing the current file.
2. Hard refresh the app.
3. Confirm the build stamp reads `LC-322`.
4. Open Modelling > Intelligent modelling and check Best Plan Finder shows above the existing Maximum sustainable spend / Earliest retirement cards.
