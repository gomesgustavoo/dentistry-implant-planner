# ImplantPlan landing

Astro + TypeScript, built independently and served by `../Dockerfile.landing`.
Node 22.12+ and npm are required.

```sh
npm ci
npm run dev -- --port 4322
npm run check
npm run build
npm run preview -- --port 4322
npm run check:browser
```

Edit product content in `src/content/project.ts` and the detailed research appendix
in `src/content/engineering.html`. The main page retains pricing, the exact plan query
parameters, trial limits, and research licensing. `/app` is routed to the application
by the production ingress; the standalone landing preview does not serve the application.

`vendor/landing-ui` is a checked-in snapshot of DicomSegVR's canonical `landing/ui`.
Edit that source and run its `npm run sync:ui` / `npm run check:ui`. The snapshot is
an npm file dependency, so CI and Docker do not need the other checkout.

`prepare:static` copies an explicit allowlist to ignored `.generated-public/`.
Astro emits `dist/`; only that directory enters the final image. The existing Three.js
modules, geometry, manifests, and asset URLs remain intact. The vendored Three.js files
are explicitly included in Git so a fresh checkout has the original renderer.
Root `styles.css` and `main.js` now belong only to the preserved legal/error pages.

From the repository root:

```sh
docker build -f Dockerfile.landing -t dentistry-landing:portfolio-preview .
node scripts/check_hero.mjs
node scripts/check_hero_browser.mjs
```

The browser geometry gate now serves `landing/dist/`; build the landing first.
`LANDING_DIST` can point it at another build. It still checks the actual GPU,
readout arithmetic, fixture neutrality, and clear → tight → breach progression.

`npm run check:browser` uses Chrome (`CHROME_BIN` overrides its path), checks the
built pages at phone/tablet/desktop widths and 200% zoom-equivalent dimensions,
and writes screenshots/results to ignored `artifacts/`. It also drives native scrolling
on desktop and mobile to verify that all three clearance states remain reachable.
The legacy `scripts/check_landing_contrast.py` covers the auxiliary pages' CSS;
new landing contrast is checked in the browser against computed colors.
