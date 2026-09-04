"""Settings for both the API pod and the host worker.

Deliberately one class for both sides: a drifting pair of config objects is how
the two halves of a queue end up disagreeing about where the data directory is.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DENT_", extra="ignore")

    # --- Postgres -----------------------------------------------------------
    # The API pod reaches postgres by cluster DNS; the host worker cannot (no
    # cluster resolver) and the platform Service is headless, so it is given the
    # plain-ClusterIP Service address instead. Same DB either way.
    DB_HOST: str = "postgres.platform.svc.cluster.local"
    DB_PORT: int = 5432
    DB_NAME: str = "dentistry"
    DB_USER: str = "dentistry"
    DB_PASSWORD: str = ""

    # --- Shared data directory ---------------------------------------------
    # A hostPath shared between the API pod and the host worker, rather than S3.
    # Both run on the single node, so object storage would buy nothing here but a
    # bucket, a scoped identity and another secret to keep in sync. Revisit when
    # the worker is containerised or a second node appears.
    DATA_DIR: str = "/data"

    # --- Model store --------------------------------------------------------
    MODEL_STORE: str = "/home/tavulha/dentistry/models"
    # The retired three-model stack's weights. These directories were destroyed with
    # the project tree on 2026-09-01 and are NOT re-fetched: nothing has run this arm
    # since the ToothFairy3 model shipped. Kept named so `PIPELINE="three-model"` fails
    # with a clear message rather than a KeyError.
    DENTALSEG_DIR: str = "dentalseg"
    TOOTHSEG_DIR: str = "toothseg_semantic"
    # ToothSeg's second branch: a border-core map at 0.2 mm whose connected cores are
    # teeth as OBJECTS. Without it the numbering is a per-voxel argmax that flips
    # across the occlusal contact and puts two numbers on one tooth -- see
    # dentistry/instances.py. Set INSTANCE_BRANCH false to fall back to that.
    TOOTHSEG_INSTANCE_DIR: str = "toothseg_instance"
    INSTANCE_BRANCH: bool = True
    # Ceiling on the DENSE float32 softmax nnU-Net materialises when asked for
    # probabilities -- n_classes x ROI voxels x 4 B, the same arithmetic as
    # MAX_LOGIT_GB. It is reduced to a sparse ProbTable the moment it arrives, but the
    # dense array exists first and it is host RAM, on a box that has been OOM-killed
    # once. Over this, the numbering runs off the argmax histogram instead: the
    # instance separation and the arch constraint are unaffected, only the split rule
    # (which needs calibrated probabilities) stops firing.
    MAX_SOFTMAX_GB: float = 3.0

    # --- ToothFairy3 U-Mamba2, the single-model pipeline --------------------
    # A directory, not a literal, because a 1000-epoch replacement for the current
    # 250-epoch checkpoint is in training and swapping it must be a config change.
    # Installed by scripts/tf3_install_model.py, which rewrites `trainer_name` to
    # `nnUNetTrainer` -- the fork's trainer classes do not exist in the serving venv.
    # Which segmentation path runs: "toothfairy3" (one model, 47 structures) or
    # "three-model" (the retired DentalSegmentator + ToothSeg stack, 37 structures).
    # A setting rather than a deletion until the single model has been measured on
    # real cases. The three-model arm's code was LOST with the project tree on
    # 2026-09-01 and deliberately not reconstructed -- nothing had run it since the
    # ToothFairy3 model shipped -- so selecting it now raises with that said plainly.
    # The default flipped at the same time: it used to be "three-model", which meant a
    # deployment without .worker.env's override would pick the dead path.
    PIPELINE: str = "toothfairy3"
    TOOTHFAIRY3_DIR: str = "toothfairy3"
    TF3_FOLD: str = "all"
    TF3_CHECKPOINT: str = "checkpoint_final.pth"
    # The winners' connected-component filter, which is TF3's single biggest
    # post-processing lever: challenge Dice +0.056 and HD95 72.4 -> 41.8 voxels at the
    # 2nd percentile. Thresholds are keyed by TASK-1 id and expressed in voxels at
    # 0.027 mm3, so this runs on the 0.3 mm grid and BEFORE the crosswalk to the
    # merged taxonomy. It replaces postprocess.remove_small_islands entirely.
    TF3_CC_TABLE: str = "toothfairy3/cc_thresholds.json"
    TF3_CC_PERCENTILE: float = 2.0
    # The structure board: a second model that OWNS the three accessory canals
    # (Task-1 43/44/45) inside an anterior-mandible ROI, leaving every other voxel
    # to the main model. Empty string switches it off and restores the single-model
    # result byte for byte. See worker/board.py for why the ordering matters.
    #
    # TF3_BOARD names which specialists run, in application order, out of the menu in
    # `board.SPECIALISTS`. Config chooses; the menu is code, because what a model owns
    # and which ROI it may touch are structural facts that belong next to the evidence
    # for them, not in an env var.
    TF3_BOARD: str = "canal"
    TF3_CANAL_SPECIALIST_DIR: str = ""
    TF3_CANAL_SPECIALIST_FOLD: str = "all"
    TF3_CANAL_SPECIALIST_CHECKPOINT: str = "checkpoint_final.pth"
    # Third-party members. Both default to SHADOW: they run and record what they would
    # have drawn without stamping anything, because our 20-case holdout is a split of
    # their own training data and cannot settle ownership either way. See eval/ownership.md.
    TF3_TOOTHSEG_DIR: str = ""
    TF3_TOOTHSEG_FOLD: str = "all"
    TF3_TOOTHSEG_CHECKPOINT: str = "checkpoint_final.pth"
    TF3_TOOTHSEG_MODE: str = "shadow"
    TF3_TOTALSEG_DIR: str = ""
    TF3_TOTALSEG_FOLD: str = "all"
    TF3_TOTALSEG_CHECKPOINT: str = "checkpoint_final.pth"
    TF3_TOTALSEG_MODE: str = "shadow"
    TF3_TOTALSEG_OWNS: tuple = ()

    # --- the extended space: merged ids 48+, composed into background only ---------
    # Three TotalSegmentator head/neck tasks (Apache-2.0) and the craniofacial model
    # that gates them. Every fold is "0": TotalSegmentator ships single-fold weights,
    # where our own models ship `fold_all`, and defaulting these to "all" would look for
    # a directory that does not exist and report the model as not installed.
    TF3_HEAD_MUSCLES_DIR: str = ""
    TF3_HEAD_MUSCLES_FOLD: str = "0"
    TF3_HEAD_MUSCLES_CHECKPOINT: str = "checkpoint_final.pth"
    TF3_HEAD_GLANDS_DIR: str = ""
    TF3_HEAD_GLANDS_FOLD: str = "0"
    TF3_HEAD_GLANDS_CHECKPOINT: str = "checkpoint_final.pth"
    TF3_HEADNECK_BONES_DIR: str = ""
    TF3_HEADNECK_BONES_FOLD: str = "0"
    TF3_HEADNECK_BONES_CHECKPOINT: str = "checkpoint_final.pth"
    # The CBCT transfer probe. NOT a model the picker offers: it draws nothing and is
    # never composed. It runs only when an extended model is requested, and its only
    # output is one Dice against our own mandible. With this unset, the probe cannot run
    # and every extended structure is withheld -- a probe that cannot run has not passed.
    TF3_CRANIOFACIAL_DIR: str = ""
    TF3_CRANIOFACIAL_FOLD: str = "0"
    TF3_CRANIOFACIAL_CHECKPOINT: str = "checkpoint_final.pth"
    # The TF3 path's own inference knobs, which differ from the three-model defaults
    # above and deliberately so. Tile step 0.9 is the winners' setting: -12.9%
    # inference time for -0.002 Dice. Mirroring is ON because this checkpoint carries
    # `inference_allowed_mirroring_axes = (0, 1)` -- superior-inferior and
    # anterior-posterior only. Left-right is excluded IN THE CHECKPOINT and must stay
    # excluded: TTA averages logits without touching label ids, so mirroring that
    # axis would average tooth 11's logit into tooth 21's position. Training may
    # mirror it only because LRMirrorTransform swaps the quadrant labels at the same
    # time.
    # Margin around the dentition that this model's output is trusted within. It is
    # a distribution guard, not a memory one: ToothFairy3's training volumes span 51
    # mm superior-inferior at the median and 89 mm at most, so a whole-head CBCT is a
    # different object rather than a bigger one, and the model labels cranial vault
    # as jawbone when it sees one. 45 mm keeps the ramus, the condyles, the sinuses
    # and the pharynx, all of which were measured to sit within 18 mm of the
    # jaws-teeth-canal box.
    TF3_FOV_PAD_MM: float = 45.0
    # The superior pad is separate and SMALLER. In canonical RPI axis 0 runs
    # superior->inferior, so this is the face that decides how far up the maxilla may
    # run -- the only one where a generous pad does harm, because "Upper Jawbone" is
    # FOV_LIMITED and its annotation is a scan edge rather than anatomy.
    #
    # Was referenced by worker/main.py and absent from here after the 2026-09-01
    # recovery: every job would have raised AttributeError at the field-of-view guard,
    # about 200 s into inference. Found by running the production path offline.
    TF3_FOV_PAD_SUP_MM: float = 20.0
    TILE_STEP_SIZE_TF3: float = 0.9
    USE_MIRRORING_TF3: bool = True

    # --- Worker knobs -------------------------------------------------------
    WORKER_POLL_SECONDS: float = 5.0
    WORKER_HEARTBEAT_SECONDS: float = 20.0
    # Inference on a 12 GB card can take minutes and may sit behind the GPU mutex
    # for minutes more; keep the requeue window well clear of both.
    WORKER_STALE_MINUTES: int = 30
    WORKER_MAX_ATTEMPTS: int = 3
    # nnU-Net sliding-window step. 0.5 is nnU-Net's default and what both
    # published models were validated with; raising it trades accuracy for speed.
    TILE_STEP_SIZE: float = 0.5
    # Test-time mirroring roughly quadruples inference time. Off by default: the
    # checkpoints carry their own inference_allowed_mirroring_axes and we would
    # rather spend the time budget on the second model.
    USE_MIRRORING: bool = False
    # Keep the full-volume logit aggregate on the CPU. Measured necessary for
    # ToothSeg's 256^3 patch on 12 GB; harmless for DentalSegmentator.
    EVERYTHING_ON_DEVICE: bool = False
    # Hard ceiling on nnU-Net's resampled logit array (n_classes x voxels x 4 B).
    # ToothSeg's 33 classes over a full 512x512x365 CBCT is 12.6 GB, which drove
    # this 24 GB box -- shared with two live GPU services and the cluster
    # Postgres -- deep into swap. A job that would exceed this is failed with a
    # clear message instead of being allowed to degrade the whole node.
    #
    # 6.0 was too generous and it took a real scan to show it. Measured whole-head
    # logit size against measured peak RSS on this box:
    #
    #     512x512x365  2.30 GB  ->  10.1 GB peak   fine
    #     433x667x667  4.62 GB  ->  11.8 GB peak   fine
    #     481x681x681  5.35 GB  ->  10.9 GB peak   fine
    #     512x512x898  5.65 GB  ->  14.3 GB and still climbing, swap exhausted
    #
    # The jump is not in the budgeted array. nnU-Net holds the logits at its own
    # working spacing AND the copy resampled back to the input grid at the same time,
    # so the true peak is closer to the sum of the two, and `logit_gb` only counts the
    # second. Predicting the first means reading the plan spacing and reproducing
    # nnU-Net's resampling arithmetic; until that is worth doing, the ceiling sits just
    # under the smallest shape that has actually misbehaved. It is calibrated on this
    # box, and it is a floor rather than a guarantee.
    MAX_LOGIT_GB: float = 5.5
    # The TF3 path's budget, and unlike MAX_LOGIT_GB above it is exact rather than a
    # floor. Two differences: nnU-Net 2.8.1 allocates the accumulator as torch.half,
    # not float32 (predict_from_raw_data.py: `dtype=torch.half`, unconditional); and
    # the TF3 path drives `predict_sliding_window_return_logits` on data already at
    # the plan spacing, so `resample_torch_simple`'s identity short-circuit fires and
    # there is no second fp32 copy at the input grid. Peak is exactly
    # 47 x voxels x 2 B, and it is a HARD ceiling on one block rather than on the
    # scan: an over-budget volume is tiled, not cropped, so this trades wall clock
    # for memory and never trades away anatomy.
    #
    # 5.0 rather than the 7.5 that would admit ToothFairy3's largest training volume
    # whole, and that is a fact about this box, not about the model. Measured at 7.5
    # on `PreDentalSurgery`: worker RSS 8.0 GB, total memory 22 GB of 23, `available`
    # at zero and the entire 14 GB page cache evicted -- the same condition that has
    # OOM-killed the k3s cluster here before. At 5.0 the peak lands near 5.5 GB and
    # leaves the cluster its cache. Every ToothFairy3-scale dental CBCT still fits in
    # one block (45.4 Mvox -> 3.97 GiB); it is whole-head scans that tile, and they
    # cost about twice one sweep.
    MAX_LOGIT_GIB: float = 5.0
    # Context kept around the teeth when cropping for the tooth model.
    ROI_MARGIN_MM: float = 15.0

    # --- Retention ----------------------------------------------------------
    RESULT_TTL_HOURS: int = 72
    UPLOAD_MAX_MB: int = 1024

    # --- Identity (Keycloak, the existing `dicomsegvr` realm) ---------------
    # ISSUER is the public host, because that is what lands in the token's `iss`
    # (Keycloak is pinned with KC_HOSTNAME_STRICT). JWKS_URL is the in-cluster
    # address, because the public host is not necessarily routable from inside the
    # cluster. They are deliberately not the same string.
    OIDC_ISSUER: str = "https://auth.dicomsegvr.com/realms/dicomsegvr"
    OIDC_JWKS_URL: str = (
        "http://keycloak.platform.svc.cluster.local:8080"
        "/realms/dicomsegvr/protocol/openid-connect/certs"
    )
    # The resource server's own client id. A front-end client without an audience
    # mapper pointing here gets a 401 for a token that is otherwise perfectly valid.
    OIDC_AUDIENCE: str = "dentistry-api"
    JWT_LEEWAY_SECONDS: int = 30
    # Off until SSO is verified in production. While false the API still validates
    # and attributes any bearer token it is given, but does not demand one -- which
    # is what lets the Keycloak rollout happen underneath the BasicAuth that is
    # currently the only thing protecting uploaded CBCTs.
    REQUIRE_AUTH: bool = False
    # The tenant that owns everything that existed before accounts did.
    LEGACY_TENANT_NAME: str = "legacy"

    @property
    def oidc_account_url(self) -> str:
        """Keycloak's own account console.

        Email, password and MFA are Keycloak's to own, and this app has no admin
        credentials to change them with -- so Settings links out rather than
        pretending to a control it does not have. Derived from the issuer so the
        two can never disagree.
        """
        return self.OIDC_ISSUER.rstrip("/") + "/account"

    # --- Trial --------------------------------------------------------------
    TRIAL_DAYS: int = 14

    # --- Stripe -------------------------------------------------------------
    # The three prices are the LIVE DicomSegVR ones, shared between the two
    # products; a Price's amount is immutable in Stripe so they cannot drift.
    # Consequence worth knowing: an invoice for a dentistry subscription reads
    # "DicomSegVR Explorer/Pro/Enterprise", because the Product name lives on the
    # Price. Fixing that means three new Products, not a code change.
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_PRICE_EXPLORER: str = ""
    STRIPE_PRICE_CLINICIAN: str = ""
    STRIPE_PRICE_ENTERPRISE: str = ""
    # Both products' webhooks see the same account's events, and a
    # client_reference_id from one is a meaningless id in the other's database. Every
    # Checkout Session we open is stamped with this, and the webhook ignores anything
    # that is not ours.
    STRIPE_PRODUCT_TAG: str = "dentistry"
    PUBLIC_BASE_URL: str = "https://dentistry.dicomsegvr.com"

    @property
    def stripe_enabled(self) -> bool:
        return bool(self.STRIPE_SECRET_KEY)

    @property
    def _price_map(self) -> dict[str, str]:
        return {
            "explorer": self.STRIPE_PRICE_EXPLORER,
            "clinician": self.STRIPE_PRICE_CLINICIAN,
            "enterprise": self.STRIPE_PRICE_ENTERPRISE,
        }

    def stripe_price_for(self, plan_id: str) -> str | None:
        """Plan id -> price id, resolved on the SERVER. A price arriving from a
        client is a price the client chose."""
        return self._price_map.get(plan_id) or None

    def plan_for_price(self, price_id: str) -> str | None:
        for plan, price in self._price_map.items():
            if price and price == price_id:
                return plan
        return None

    @property
    def db_url(self) -> str:
        return (
            f"postgresql+psycopg://{self.DB_USER}:{self.DB_PASSWORD}"
            f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        )


settings = Settings()
