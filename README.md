# LC-330 direct upload pack

Upload these files to the repository root:

- app.html
- intelligent_modelling.html
- best_plan_engine.js

## Changes

- Intelligent Modelling controls now remember their last browser values using localStorage.
- This includes Model/withdrawal selections and Best Plan annuity include/exclude.
- Values are remembered locally in the browser only.
- No Supabase writes.
- No Apply button.
- No Save feature.
- Main Modelling remains divorced from Intelligent Modelling.
- app.html build stamp updated to LC-330 and frame cache-buster bumped to front33.
- intelligent_modelling.html build updated to im5.
- best_plan_engine.js is included unchanged from bpe4.

## Upload notes

After uploading, hard refresh the app and check the top stamp shows LC-330.
