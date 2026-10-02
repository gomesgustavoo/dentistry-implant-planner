# Self-hosting ImplantPlan

The whole stack runs on one machine with an NVIDIA GPU: Postgres, the API, the GPU
worker and the web app, started by `compose.yaml`. It needs no accounts and no cloud
service, and no scan leaves the machine. The only network access is the one-time model
download (or a mirror of it, below).

## What you need

| | |
|---|---|
| GPU | NVIDIA with **≥ 12 GB** of memory. Validated on an RTX 3080 (12 GB). |
| Driver | New enough for CUDA 13: **R580 or later** (`nvidia-smi` shows it). |
| Container runtime | Docker with the Compose plugin, and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) configured for Docker (`sudo nvidia-ctk runtime configure --runtime=docker`, then restart Docker). |
| Memory and disk | The reference machine has 24 GB of RAM. The worker image is several GB (the CUDA wheels), the weights ~1 GB, and each finished case up to a few hundred MB until its results expire. |

A machine without a suitable GPU can still run the API and the web app to browse and
plan existing results, but it cannot segment new scans: U-Mamba2's selective scan is a
CUDA (Triton) kernel with no CPU path.

## Start it

```bash
git clone https://github.com/gomesgustavoo/dentistry-implant-planner.git
cd dentistry-implant-planner
cp .env.example .env            # set POSTGRES_PASSWORD to a long random string
docker compose build            # the worker image is large (CUDA wheels): first build takes a while
docker compose run --rm worker python scripts/fetch_models.py --toothseg
docker compose up -d
```

Open **http://127.0.0.1:8080**. There is no sign-in page. The catalogue says *"This
server runs without accounts"*, which is accurate: see [Security](#security) below.

`fetch_models.py` downloads the two first-party networks (the ToothFairy3 U-Mamba2 base
model and the anterior canal specialist) and, with `--toothseg`, the optional ToothSeg
teeth specialist from Zenodo. Every file is checked against the SHA-256 pinned in
`scripts/models.manifest.json`. A mismatch deletes the file and fails, so a partial or
substituted checkpoint is never installed. Run it again at any time: files that are
already present and verified are skipped.

Check the worker found its models:

```bash
docker compose logs worker | grep -i inventory
curl -s http://127.0.0.1:8080/v1/models | python3 -m json.tool | grep -E '"key"|"installed"'
```

## Use it

Drop a CBCT (NIfTI `.nii` / `.nii.gz`, or a DICOM series as a `.zip`) on the catalogue.
The job runs on your GPU. On an RTX 3080, the base model takes about 95 s and the full
set of derived views a little longer. Open the finished case to review the segmentation,
correct it if needed, and plan implants on the *Implant plan* tab.

## Settings

Everything is in `.env` (read by `compose.yaml`):

| Variable | Meaning |
|---|---|
| `POSTGRES_PASSWORD` | The stack's own database password. |
| `WEB_PORT` | Port on `127.0.0.1` (default 8080). |
| `DENT_RESULT_TTL_HOURS` | How long finished results are kept (default 72). Uploads are deleted as soon as a job finishes. |
| `DENT_UPLOAD_MAX_MB` | Largest accepted upload (default 1024). |
| `DENT_GPU_LOCK` / `GPU_LOCK_DSN` | See [Sharing the GPU](#sharing-the-gpu). |
| `DENT_TF3_TOOTHSEG_DIR` | Leave empty to run without the ToothSeg specialist. |

Data lives in Docker volumes (`implantplan_db`, `implantplan_data`) and weights in
`./models`.

## Sharing the GPU

By default the worker assumes it has the GPU to itself (`DENT_GPU_LOCK=off`, logged once
at start-up). If other GPU services on the machine take the same Postgres advisory lock,
point the worker at that database:

```bash
DENT_GPU_LOCK=required
GPU_LOCK_DSN=postgresql+psycopg://gpulock:...@host:5432/gpulock
```

With `required`, a missing DSN is an error rather than a silent run without the lock.

## Offline and mirrored weights

The manifest's hashes, not the host, make a download trustworthy. Any server holding the
same paths works:

```bash
IMPLANTPLAN_WEIGHTS_URL=https://files.my-clinic.lan/implantplan-weights \
  docker compose run --rm -e IMPLANTPLAN_WEIGHTS_URL worker python scripts/fetch_models.py
```

Or copy a model store from another machine into `./models` and run `fetch_models.py` to
verify it.

## Updating

```bash
git pull
docker compose build
docker compose run --rm worker python scripts/fetch_models.py
docker compose up -d
```

The database migrates itself on API start-up.

## Resetting

`docker compose down` stops the stack and keeps the data. `docker compose down -v` also
deletes every case and the database.

## Security

**Without accounts, anyone who can reach the app can see and delete every case on it.**
That is why `compose.yaml` binds only to `127.0.0.1`. To share the server:

- put it behind your own VPN, or behind a reverse proxy that authenticates users; or
- turn accounts on. Set `DENT_REQUIRE_AUTH=true`, `DENT_OIDC_ISSUER`,
  `DENT_OIDC_JWKS_URL` and `DENT_OIDC_AUDIENCE` on the API, and `DENT_WEB_OIDC_AUTHORITY`
  and `DENT_WEB_OIDC_CLIENT_ID` on the web container. The web client is a public client
  using authorization code + PKCE, with its redirect URI at the app's root.

Scans are patient data. Make sure running this server meets the data-protection rules
that apply to you. See also [`SECURITY.md`](../SECURITY.md).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `could not select device driver "" with capabilities: [[gpu]]` | The NVIDIA Container Toolkit is not configured for Docker. |
| Worker exits with `GPU_LOCK_DSN is unset` | `DENT_GPU_LOCK=required` without a DSN; set one, or `off`. |
| A model shows *Not installed on this server* | Run `fetch_models.py`; the worker re-reports its inventory on restart (`docker compose restart worker`). |
| CUDA out of memory | Less than 12 GB free on the GPU, often another process holding it (`nvidia-smi`). |
| Upload rejected as too large | Raise `DENT_UPLOAD_MAX_MB`. |

## Licences

The code is MIT. The first-party weights are **CC BY-NC-SA 4.0** (derived from the
ToothFairy3 dataset): research and non-commercial use only. ToothSeg is CC BY 4.0. This
is research software, **not a medical device**.
