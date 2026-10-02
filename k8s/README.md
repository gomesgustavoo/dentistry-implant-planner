# Deploy

Recovered 2026-09-01 by dumping the live cluster (`kubectl -n dentistry get ... -o yaml`)
after the project tree was destroyed. Server-assigned fields — `status`, `uid`,
`resourceVersion`, `clusterIP`, `nodePort`, `last-applied-configuration` — are stripped,
so these apply cleanly.

## Not in here, deliberately

`secret/dentistry-secrets` holds `DB_PASSWORD`, `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET`. It lives in the cluster and is **not** dumped into the repo.
`base/20-api.yaml` references it by name; recreate it by hand if the namespace is ever
rebuilt from scratch.

## Rolling a new version

There is no registry and `imagePullPolicy: IfNotPresent`, so **a same-tag rebuild will
not roll.** Always use a new tag:

    ./build-images.sh 0.11.0 web
    sudo k3s kubectl -n dentistry set image deploy/dentistry-web web=dentistry/web:0.11.0
    sudo k3s kubectl -n dentistry rollout status deploy/dentistry-web

Rollback is the same command with the previous tag; `revisionHistoryLimit: 10` also
allows `kubectl rollout undo`.

## Layout

| path | holds |
|---|---|
| `base/` | the deployable manifests with every per-deployment value as a placeholder (`implantplan.example.com`, `price_REPLACE_ME`, an `auth.example.com` realm, hostPath `/srv/implantplan/data`) |
| `base/10-config.yaml` | `configmap/dentistry-config`: the API's settings (`DENT_*`) |
| `base/20-api.yaml` | api Deployment + Service. Mounts `/data` and runs as uid 1000 |
| `base/21-web.yaml` | the SPA Deployment + Service. `DENT_WEB_OIDC_*` become the app's `config.js` at start |
| `base/22-landing.yaml` | the marketing site, unprivileged on 8080 |
| `ingress.example.yaml` | the four traefik routes the app needs on one hostname |
| `overlays/<name>/` | **yours, and git-ignored**: a kustomization over `../../base` that sets the real values |

Deploy with an overlay, and diff before the first apply:

    kubectl diff  -k k8s/overlays/production
    kubectl apply -k k8s/overlays/production

The GPU worker is not in here: the hosted service runs it as a host systemd unit
(`python -m worker.main` with an env file), and the self-hosted stack runs it as the
`worker` service in `compose.yaml` (see `docs/self-hosting.md`).
