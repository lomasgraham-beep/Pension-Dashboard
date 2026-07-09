# LC-326 — Standalone Intelligent Modelling

Upload these files to the repository root:

1. `app.html`
2. `intelligent_modelling.html`
3. `best_plan_engine.js`

## What changed

- Added a new top-level **Intelligent Modelling** tab.
- Moved intelligent modelling tools out of the main Modelling page.
- Removed Best Plan Finder, Maximum Sustainable Spend, and Earliest Retirement Age from the main Retirement Model page.
- Rebuilt the intelligent tools as read-only sandbox pages:
  - Best Plan Finder
  - Maximum Sustainable Spend
  - Earliest Retirement Age
- The sandbox reads Supabase data and uses `PensionEngine`, but it does not mutate the main model state and does not write to Supabase.
- No Apply button. No Save. If a result looks good, manually enter it into the main model.

## Files unchanged

- `engine.js`
- `optimiser.js`
- `common.js`
- SQL schema

## Test

After upload, hard refresh and confirm the app build stamp shows `LC-326`.
Open **Intelligent Modelling** from the top navigation and run each tool.
