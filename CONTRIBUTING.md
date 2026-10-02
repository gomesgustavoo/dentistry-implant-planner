# Contributing

Thank you for helping. A few things keep this codebase honest; please keep them.

## Before you open a pull request

Run the gates (see the README's "Gates" section for what each one proves):

```bash
./venv/bin/python -m pytest tests/ -q
node web-auth/check-app.js
node web-auth/golden.mjs            # re-record with --update only for an intended change, and review the diff
node web-auth/check-rail.mjs        # --prove: every assertion is shown to fail when broken
```

- An assertion that cannot be shown to fail is a bug. New checks come with a `--prove` break.
- The web app has no build step: classic scripts under `web/js/`, one stylesheet, no
  bundler. `web/viewer.js` and `web/auth.js` are committed bundles built from `viewer/`
  and `web-auth/`.
- Never quote absolute Hounsfield units or bone-density classes in a measurement: CBCT
  grey values are not calibrated.
- Keep behaviour changes and refactors in separate commits.

## Licences

- Code: MIT (`LICENSE`).
- First-party model weights: CC BY-NC-SA 4.0, derived from the ToothFairy3 dataset. They
  are not in this repository; `scripts/fetch_models.py` downloads them.
- By contributing you agree your contribution is released under the MIT licence.
