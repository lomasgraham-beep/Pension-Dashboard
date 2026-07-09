# LC-332 direct upload pack

Upload these files to the GitHub repo root:

- `app.html`
- `intelligent_modelling.html`
- `best_plan_engine.js`

## Changes

- Adds a remembered Joint / Graham / Julie filter to the Intelligent Modelling chart area.
- Applies the selected view to the pot chart, income/outgoings chart, and yearly table.
- Keeps the Intelligent Modelling tools read-only and divorced from the main Modelling page.
- Updates the app build stamp to LC-332 and bumps the framed-page cache buster to `front35`.

## Unchanged

- No SQL.
- No Supabase writes.
- No Save or Apply.
- `engine.js`, `optimiser.js`, and `common.js` unchanged.
