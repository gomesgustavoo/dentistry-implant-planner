# web-auth

The `DentistryAuth` bundle, and the two browser check harnesses.

Rebuilt 2026-09-01. `web/auth.js` (the built output) survived the deletion of the project
tree because it ships inside the web image; **its source did not**, and there is no
sourcemap — so `src/auth.js` is a re-implementation of the wrapper, not a decompilation.
Most of those 71 KB is vendored `oidc-client-ts`; what was actually lost is ~120 lines.

## Is the reconstruction faithful?

Measured rather than assumed:

| | original | rebuilt |
|---|---|---|
| bundle size | 70 972 B | 70 962 B |
| exported names | `init, isSignedIn, profile, signIn, signOut, token` | identical |
| every OIDC setting | authority, client_id, response_type, scope, the two silent-renew flags, `monitorSession: false` | **identical, key for key** |
| `isSignedIn()` / `profile()` signed out | `false` / `null` | `false` / `null` |

Both were loaded into real Chrome against a real origin and compared. (They also failed
identically on `about:blank` — six columns apart — which was itself the signal that the
structure matches: `sessionStorage` throws on an opaque origin.)

## Why `web/auth.js` has NOT been replaced

This is live authentication. Size and API surface agreeing is strong evidence, but the
only proof that matters is a full Keycloak round-trip — a real redirect, a real
authorization code, a real silent renew — and that needs a human to sign in.

To swap it:

    npm --prefix web-auth run build      # writes ../web/auth.js directly
    # sign in at https://dentistry.dicomsegvr.com/app/ in a real browser,
    # open a case, leave it idle past the token expiry to exercise the renew

Revert with `git checkout web/auth.js`, or from `dist/` if the tree is still ungoverned.
Until that round-trip has been done, `web/auth.js` is the known-good artifact and
`dist/auth.js` is the candidate.

## The harnesses

    node web-auth/check-app.js            # static wiring: every render* is declared and called
    node web-auth/check-rail.mjs          # 60 measured states in real Chrome
    node web-auth/check-rail.mjs --prove  # break each assertion, confirm it fails
    node web-auth/check-rail.mjs --selftest   # the JS half of the coordinate map
