# Deploy

Recovered 2026-09-01 by dumping the live cluster (`kubectl -n dentistry get ... -o yaml`)
after the project tree was destroyed. Server-assigned fields — `status`, `uid`,
`resourceVersion`, `clusterIP`, `nodePort`, `last-applied-configuration` — are stripped,
so these apply cleanly.

## Not in here, deliberately

`secret/dentistry-secrets` holds `DB_PASSWORD`, `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET`. It lives in the cluster and is **not** dumped into the repo.
`20-api.yaml` references it by name; recreate it by hand if the namespace is ever
rebuilt from scratch.

## Rolling a new version

There is no registry and `imagePullPolicy: IfNotPresent`, so **a same-tag rebuild will
not roll.** Always use a new tag:

    ./build-images.sh 0.11.0 web
    sudo k3s kubectl -n dentistry set image deploy/dentistry-web web=dentistry/web:0.11.0
    sudo k3s kubectl -n dentistry rollout status deploy/dentistry-web

Rollback is the same command with the previous tag; `revisionHistoryLimit: 10` also
allows `kubectl rollout undo`.

## Files

| file | holds |
|---|---|
| `10-config.yaml` | `configmap/dentistry-config` — 17 keys incl. the OIDC issuer and audience |
| `20-api.yaml` | api Deployment + Service. Mounts `/data` and runs as uid 1000 |
| `21-web.yaml` | the SPA Deployment + Service, 2 replicas, port 80 |
| `22-landing.yaml` | the marketing site, unprivileged on 8080 |
| `40-ingress.yaml` | all five traefik ingresses on `dentistry.dicomsegvr.com` |
