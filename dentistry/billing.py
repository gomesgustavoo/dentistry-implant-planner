"""Stripe: Checkout, the customer portal, and the webhook that applies the result.

Modelled on `dicomsegvr/backend/app/routes/billing.py`, keeping the parts that
matter and dropping the part that does not: Checkout here is **hosted**, not
embedded, so the SPA needs neither `@stripe/stripe-js` nor a bundler for it. The
API returns a URL and the browser goes there.

**The three prices are shared with DicomSegVR.** That is deliberate (the user asked
for it) and it has one consequence worth stating plainly: both products' webhooks
see the same Stripe account's events, and a `client_reference_id` minted by one is
a meaningless id in the other's database. Two defences, both required:

1. A separate webhook endpoint with its own signing secret, so a signature from
   the other endpoint does not verify here.
2. Every Session we open is stamped `metadata.product`, and this webhook ignores
   any event that is not ours. Without the tag an unlabelled event is ambiguous,
   and the sibling's handler would silently no-op on a dentistry customer rather
   than fail loudly.

Also worth knowing: the invoice and the customer portal will say "DicomSegVR
Explorer/Pro/Enterprise", because the Product name lives on the Price. Fixing that
needs three new Stripe Products, not a code change.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException, status
from sqlalchemy import text

from . import db
from .config import settings

log = logging.getLogger("dentistry.billing")

# Pinned so a Stripe library upgrade cannot silently change response shapes under
# us. Matches what the sibling service already runs against.
STRIPE_API_VERSION = "2026-05-27.dahlia"

PURCHASABLE = ("explorer", "clinician", "enterprise")

_stripe = None


def stripe():
    """Import and configure Stripe lazily.

    The API must boot with no keys -- a dev machine, and the production rollout
    step that deploys this image *before* the secrets are attached. Callers that
    need Stripe raise 503; nothing else notices.
    """
    global _stripe
    if not settings.stripe_enabled:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Billing is not configured")
    if _stripe is None:
        import stripe as _s

        _s.api_key = settings.STRIPE_SECRET_KEY
        _s.api_version = STRIPE_API_VERSION
        _stripe = _s
    return _stripe


def _as_dict(obj) -> dict:
    """`StripeObject` is not a dict in stripe>=8, and `.get()` on it lies about
    nested objects. Round-trip through the library's own serialiser."""
    if isinstance(obj, dict):
        return obj
    return dict(obj.to_dict_recursive()) if hasattr(obj, "to_dict_recursive") else dict(obj)


def _subscription_row(session, tenant_id: str) -> dict:
    row = session.execute(text(
        "SELECT id, stripe_customer_id, plan_id, status, stripe_subscription_id "
        "FROM subscriptions WHERE tenant_id = :t FOR UPDATE"
    ), {"t": tenant_id}).first()
    if row is None:
        raise HTTPException(404, "No subscription for this account")
    return {"id": row[0], "customer": row[1], "plan_id": row[2], "status": row[3],
            "stripe_subscription_id": row[4]}


def _ensure_customer(session, tenant_id: str, sub: dict, email: str | None) -> str:
    """Reuse the stored customer, but VALIDATE it first.

    A customer id created in test mode does not exist in live mode (and vice
    versa). Reusing one blindly fails the Checkout with an error that reads like a
    Stripe outage rather than a mode mismatch.
    """
    s = stripe()
    cid = sub.get("customer")
    if cid:
        try:
            existing = s.Customer.retrieve(cid)
            if not getattr(existing, "deleted", False):
                return cid
        except s.error.InvalidRequestError:
            log.warning("stored customer %s is not valid in this Stripe mode; recreating", cid)

    customer = s.Customer.create(
        email=email or None,
        metadata={"product": settings.STRIPE_PRODUCT_TAG, "tenant_id": tenant_id},
    )
    session.execute(text(
        "UPDATE subscriptions SET stripe_customer_id = :c WHERE tenant_id = :t"
    ), {"c": customer.id, "t": tenant_id})
    return customer.id


def create_checkout(session, tenant_id: str, plan_id: str, email: str | None) -> str:
    """Open a hosted Checkout Session and return its URL."""
    if plan_id not in PURCHASABLE:
        raise HTTPException(400, f"{plan_id} is not a purchasable plan")
    # Resolved on the SERVER. A price arriving from a client is a price the client
    # chose, and the client does not get to choose what it pays.
    price = settings.stripe_price_for(plan_id)
    if not price:
        raise HTTPException(503, f"No Stripe price configured for {plan_id}")

    # FOR UPDATE, so two tabs cannot each mint a customer for the same tenant.
    sub = _subscription_row(session, tenant_id)

    # A tenant that already pays must go through the portal, never through a second
    # Checkout. `subscriptions` has ONE row per tenant (unique index), so a second
    # Stripe subscription would not even be representable here -- the webhook would
    # overwrite the row and the customer would quietly be charged for both. Stripe
    # will happily create it; this is the only thing that stops it.
    #
    # Deliberately keyed on the live Stripe subscription id rather than on
    # `status == active`: a tenant whose card failed is `past_due` and still has a
    # subscription to fix, not a new one to buy.
    #
    # BEFORE `stripe()`, and that ordering is the point: this must answer 409 on a
    # deployment with no Stripe key just as it does on a configured one, and it must
    # not build a client it is about to refuse to use.
    if sub and sub.get("stripe_subscription_id"):
        raise HTTPException(
            409,
            "This account already has a subscription. Use the billing portal to change plan.",
        )

    s = stripe()
    customer = _ensure_customer(session, tenant_id, sub, email)

    base = settings.PUBLIC_BASE_URL.rstrip("/")
    tag = {"product": settings.STRIPE_PRODUCT_TAG, "tenant_id": tenant_id, "plan_id": plan_id}
    cs = s.checkout.Session.create(
        mode="subscription",
        customer=customer,
        line_items=[{"price": price, "quantity": 1}],
        # Bound to the tenant three ways, because different webhook events carry
        # different ones: the Session has client_reference_id and metadata, but a
        # later `customer.subscription.updated` has only the customer id.
        client_reference_id=tenant_id,
        metadata=tag,
        subscription_data={"metadata": tag},
        success_url=f"{base}/app?checkout=success",
        cancel_url=f"{base}/app?checkout=cancelled",
        allow_promotion_codes=True,
    )
    session.commit()
    log.info("checkout opened for tenant %s plan %s", tenant_id, plan_id)
    return cs.url


def create_portal(session, tenant_id: str) -> str:
    s = stripe()
    row = session.execute(text(
        "SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = :t"
    ), {"t": tenant_id}).first()
    if not row or not row[0]:
        raise HTTPException(400, "No billing account yet -- subscribe first")
    base = settings.PUBLIC_BASE_URL.rstrip("/")
    return s.billing_portal.Session.create(
        customer=row[0], return_url=f"{base}/app?billing=return"
    ).url


_STATUS_MAP = {
    "active": db.ACTIVE,
    "trialing": db.TRIALING,
    "past_due": db.PAST_DUE,
    "unpaid": db.PAST_DUE,
    "incomplete": db.PAST_DUE,
    "paused": db.PAST_DUE,
    "canceled": db.CANCELED,
    "incomplete_expired": db.CANCELED,
}


def _period_end(sub: dict):
    """`current_period_end` moved onto the subscription ITEM in recent API
    versions. Read the top level, then fall back, so one Stripe upgrade does not
    quietly start reporting a null renewal date."""
    if sub.get("current_period_end"):
        return sub["current_period_end"]
    items = ((sub.get("items") or {}).get("data")) or []
    return items[0].get("current_period_end") if items else None


def _apply(session, tenant_id: str, stripe_sub: dict) -> None:
    """Write ABSOLUTE state from the subscription object.

    Absolute, not incremental, which is what makes webhook redelivery idempotent
    with no processed-events table: applying the same event twice is a no-op
    because the second write says exactly what the first one said.
    """
    items = ((stripe_sub.get("items") or {}).get("data")) or []
    price_id = ((items[0].get("price") or {}).get("id")) if items else None
    plan_id = settings.plan_for_price(price_id) if price_id else None
    status_ = _STATUS_MAP.get(stripe_sub.get("status"), db.PAST_DUE)
    period_end = _period_end(stripe_sub)

    sets = ["status = :st", "stripe_subscription_id = :sid", "cancel_at_period_end = :cape"]
    params = {
        "t": tenant_id, "st": status_, "sid": stripe_sub.get("id"),
        "cape": bool(stripe_sub.get("cancel_at_period_end")),
    }
    if plan_id:
        sets.append("plan_id = :pid")
        params["pid"] = plan_id
    elif price_id:
        # An unknown price is far more likely to be the OTHER product's than a
        # mistake here. Never clobber the plan on a guess.
        log.warning("price %s maps to no plan; leaving plan_id alone", price_id)
    if period_end:
        sets.append("current_period_end = to_timestamp(:pe)")
        params["pe"] = period_end
    # A paid subscription ends the local trial. Leaving trial_ends_at set would let
    # an expired trial keep 402-ing a paying customer.
    if status_ == db.ACTIVE:
        sets.append("trial_ends_at = NULL")

    session.execute(text(
        f"UPDATE subscriptions SET {', '.join(sets)} WHERE tenant_id = :t"
    ), params)
    log.info("tenant %s -> plan %s status %s", tenant_id, plan_id or "(unchanged)", status_)


def _tenant_for_customer(session, customer_id: str) -> str | None:
    row = session.execute(text(
        "SELECT tenant_id FROM subscriptions WHERE stripe_customer_id = :c"
    ), {"c": customer_id}).first()
    return row[0] if row else None


def _is_ours(obj: dict) -> bool:
    """Is this event about this product?

    The two products share their Stripe prices, so the tag is the only thing that
    separates them. An event with no tag at all predates tagging or came from
    somewhere else; either way it is not safe to act on, because acting means
    changing somebody's plan.
    """
    tag = (obj.get("metadata") or {}).get("product")
    return tag == settings.STRIPE_PRODUCT_TAG


def handle_webhook(session, payload: bytes, signature: str | None) -> dict:
    """Verify and apply. Returns a small dict for the response body and the log."""
    s = stripe()
    if not settings.STRIPE_WEBHOOK_SECRET:
        raise HTTPException(503, "Webhook secret is not configured")
    if not signature:
        raise HTTPException(400, "Missing Stripe-Signature")
    try:
        # Against the RAW body. Any reserialisation changes the bytes and the
        # signature stops matching.
        event = s.Webhook.construct_event(payload, signature, settings.STRIPE_WEBHOOK_SECRET)
    except ValueError as exc:
        raise HTTPException(400, "Malformed payload") from exc
    except s.error.SignatureVerificationError as exc:
        raise HTTPException(400, "Bad signature") from exc

    etype = event["type"]
    obj = _as_dict(event["data"]["object"])

    if etype == "checkout.session.completed":
        if not _is_ours(obj):
            return {"ignored": etype, "reason": "not this product"}
        tenant_id = obj.get("client_reference_id") or (obj.get("metadata") or {}).get("tenant_id")
        if not tenant_id:
            return {"ignored": etype, "reason": "no tenant reference"}
        sub_id = obj.get("subscription")
        session.execute(text(
            "UPDATE subscriptions SET stripe_customer_id = :c, stripe_subscription_id = :s "
            " WHERE tenant_id = :t"
        ), {"c": obj.get("customer"), "s": sub_id, "t": tenant_id})
        if sub_id:
            # Re-fetch rather than trusting the payload: the Session carries the
            # subscription id, not its authoritative state.
            _apply(session, tenant_id, _as_dict(s.Subscription.retrieve(sub_id)))
        session.commit()
        return {"applied": etype, "tenant": tenant_id}

    if etype in ("customer.subscription.created", "customer.subscription.updated",
                 "customer.subscription.deleted"):
        if not _is_ours(obj):
            return {"ignored": etype, "reason": "not this product"}
        tenant_id = (obj.get("metadata") or {}).get("tenant_id") \
            or _tenant_for_customer(session, obj.get("customer"))
        if not tenant_id:
            return {"ignored": etype, "reason": "unknown customer"}
        if etype == "customer.subscription.deleted":
            session.execute(text(
                "UPDATE subscriptions SET status = :st, cancel_at_period_end = false "
                " WHERE tenant_id = :t"
            ), {"st": db.CANCELED, "t": tenant_id})
        else:
            _apply(session, tenant_id, obj)
        session.commit()
        return {"applied": etype, "tenant": tenant_id}

    return {"ignored": etype}
