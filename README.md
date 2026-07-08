# LC-321 direct upload

Upload only this file to the repository root:

- app.html

No separate best_plan_finder_addon.js is required.

## Fix in LC-321

Best Plan Finder is embedded in app.html and is inserted directly into the Intelligent modelling section (`#optPair`), above the Maximum sustainable spend and Earliest retirement age cards. This matches the position shown in Graham's screenshot.

## Checks

- Build stamp updated to LC-321.
- Embedded Best Plan Finder build is bpf4.
- Inline JavaScript syntax checked with `node --check`.
