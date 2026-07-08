# LC-318 Best Plan Finder v1

Files in this pack:

- `app.html` — complete LC-318 replacement for the current dashboard shell.
- `best_plan_finder_addon.js` — new additive Best Plan Finder feature file.

## Upload order

1. Upload `best_plan_finder_addon.js` to the repo root.
2. Upload `app.html` to replace the existing repo `app.html`.
3. Hard refresh the app.
4. Confirm the build stamp shows `LC-318`.

## What changed

- Adds Best Plan Finder to the Intelligent modelling section.
- Keeps `engine.js` unchanged.
- Keeps `optimiser.js` unchanged.
- Adds a new script reference in `app.html`:

```html
<script src="best_plan_finder_addon.js?v=bpf2"></script>
```

## Behaviour

Best Plan Finder v1 uses:

- editable earliest retirement date;
- editable latest date to test;
- editable minimum pot reserve;
- reserve scope: combined / Graham / Julie;
- fixed user-entered annuity purchase amount;
- editable annuity date, owner, rate and escalation;
- include-crashes toggle;
- no-shortfall toggle;
- must-buy-annuity toggle.

The agreed annuity rule is:

```text
Use the fixed annuity amount, but fail if the purchase would take the relevant pot below the protected reserve or if the selected member pot cannot afford the annuity.
```

## Apply to current model

`Apply to current model`:

- updates the visible retirement date;
- adds the Best Plan Finder annuity to the in-memory model;
- reruns the normal Modelling charts;
- does not write directly to Supabase;
- does not create or overwrite a saved model.

The LC-318 `app.html` also adjusts the existing Save model collection step so that, after applying Best Plan Finder, the in-memory annuity is captured when you choose Save model.

## SQL

No SQL changes are required.

## Files not changed

- `engine.js`
- `optimiser.js`
- `common.js`
- Supabase schema / RLS
