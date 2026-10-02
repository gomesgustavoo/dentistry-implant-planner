// Deployment configuration. The container rewrites this file at start-up from its
// environment (docker/web-entrypoint.d/40-dentistry-config.sh), so one image serves
// every deployment. This committed copy is the SELF-HOSTED default: no sign-in, and no
// upload cap beyond the server's own.
//
//   oidc             null, or { authority, client_id } of an OpenID Connect provider.
//                    null means the app runs without accounts.
//   edgeBodyLimitMB  null, or the request-body cap of a CDN in front of the app, so an
//                    over-size upload is refused with the real reason before it starts.
window.DENTISTRY_CONFIG = window.DENTISTRY_CONFIG || { oidc: null, edgeBodyLimitMB: null };
