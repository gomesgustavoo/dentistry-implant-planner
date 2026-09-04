"""Stripe endpoints. The logic lives in `dentistry/billing.py`.

Note what is NOT authenticated: the webhook. Stripe does not carry a bearer token,
and its signature is the authentication -- which is why it must read the raw body.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import Caller, current_caller, get_session
from dentistry import billing

log = logging.getLogger("dentistry.api.billing")

router = APIRouter(prefix="/v1/billing", tags=["billing"])


class CheckoutRequest(BaseModel):
    planId: str


@router.post("/checkout")
def checkout(
    body: CheckoutRequest,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    """Open a hosted Checkout Session. Returns a URL for the browser to visit.

    Hosted rather than embedded so the deliberately build-free SPA needs neither
    the Stripe JS SDK nor a second bundler.
    """
    return {"url": billing.create_checkout(s, caller.tenant_id, body.planId, caller.email)}


@router.post("/portal")
def portal(
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    return {"url": billing.create_portal(s, caller.tenant_id)}


@router.post("/webhook")
async def webhook(request: Request, s: Session = Depends(get_session)) -> dict:
    # The RAW body. Any reserialisation changes the bytes and the signature stops
    # verifying -- and it would look like Stripe sending bad signatures.
    payload = await request.body()
    result = billing.handle_webhook(s, payload, request.headers.get("stripe-signature"))
    log.info("stripe webhook: %s", result)
    return result
