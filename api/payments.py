# community/payments.py

import asyncio
import stripe
import hashlib
import hmac
import os
import time
import logging
import re
from fastapi import APIRouter, Request, Header, HTTPException, Depends, Security
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, EmailStr

# --- Project-specific Imports ---
# This is your dependency for getting the current authenticated user.
from auth import AuthUser
# We need the functions we designed to interact with Auth0.
from auth0_manager import (
    update_user_subscription_status,
    find_user_by_stripe_customer_id,
    find_user_by_email,
    get_email_by_id,
    check_apple_subscription_by_email,
    get_user_app_metadata,
    CLEAR_FIELD
)
# Admin authentication
from admin_auth import get_admin_access
# Enterprise org sync (orgs.py does not import payments, so this is not circular)
from orgs import sync_org_from_stripe, sget, provision_org, OrgCreateRequest

# --- Standard Setup ---
logger = logging.getLogger(__name__)
payments_router = APIRouter()

# The stripe SDK is synchronous. Every Stripe call in this module runs in a
# worker thread (asyncio.to_thread), never directly in an async handler, where
# each round trip would stall every other request on the worker's event loop.
# Plain `def` helpers below are the thread-side code: they may call Stripe
# directly, and async code calls them through asyncio.to_thread.

# --- Configuration from Environment Variables ---
# Make sure these are set in your environment or .env file
try:
    stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
    WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]
    PRO_PRICE_ID = os.environ["STRIPE_PRO_PRICE_ID"]
    # Max tier price ID is optional - if not set, Max tier won't be available
    MAX_PRICE_ID = os.environ.get("STRIPE_MAX_PRICE_ID")
    # Plus tier price ID is optional - if not set, Plus tier won't be available
    PLUS_PRICE_ID = os.environ.get("STRIPE_PLUS_PRICE_ID")
except KeyError as e:
    logger.critical(f"FATAL: Missing required environment variable: {e}. Payments API will not work.")
    raise RuntimeError(f"Missing environment variable: {e}") from e


# Price ID to tier mapping for determining subscription level
def get_tier_from_price(price_id: str) -> tuple[bool, bool, bool]:
    """
    Returns (is_pro, is_max, is_plus) for a given price_id.
    """
    if price_id == MAX_PRICE_ID:
        return (True, True, False)  # Max users are also pro
    elif price_id == PRO_PRICE_ID:
        return (True, False, False)
    elif price_id == PLUS_PRICE_ID:
        return (False, False, True)
    else:
        logger.warning(f"Unknown price_id: {price_id}")
        return (False, False, False)


def _list_personal_customers(email: str, limit: int = 100) -> list:
    """
    Stripe customers for `email`, excluding enterprise org billing entities.

    An org's Stripe customer carries the billing contact's email so the invoice
    reaches a human, which means a plain email lookup for that person returns it
    alongside their personal customers. Every personal-billing path must filter
    it out: attaching a personal subscription to it bills the company, and the
    webhook then routes the event into the org path where that subscription is
    invisible — the user pays and receives no entitlement.
    """
    try:
        customers = stripe.Customer.list(email=email, limit=limit)
    except Exception as e:
        logger.error(f"Failed to list Stripe customers for {email}: {e}")
        return []

    personal = []
    for cust in customers.data:
        if sget(cust.metadata, "org_id"):
            logger.info(f"Excluding org-owned customer {cust.id} from personal lookup for {email}")
            continue
        personal.append(cust)
    return personal


def reject_if_org_member(user: AuthUser) -> None:
    """
    Enterprise seat holders are covered by their company's plan, so personal
    checkout is closed to them. Beyond the double-billing, seating clears their
    stripe_customer_id, so checkout would fall back to an email lookup and could
    attach the subscription to the wrong customer entirely.
    """
    if getattr(user, "org_id", None):
        raise HTTPException(
            status_code=400,
            detail="Your Observer plan is provided by your organization. "
                   "Contact your team admin to change your seat.",
        )


async def has_active_subscription(email: str) -> tuple[bool, str | None, str | None, str | None]:
    """
    Single source-of-truth check for active subscriptions across all providers.

    - Apple: queries Auth0 metadata by email (cache of client-verified JWS transactions)
    - Stripe: queries Stripe directly by email (source of truth)

    Use this instead of checking JWT metadata, which can be stale.

    Args:
        email: User's email address

    Returns:
        (has_subscription, subscription_id, provider, stripe_customer_id)
        provider is "apple" or "stripe" or None
        stripe_customer_id is only set when provider is "stripe"
    """
    if not email:
        return False, None, None, None

    email = email.lower()

    # 1. Check Apple (Auth0 metadata is cache of client-verified JWS transactions)
    has_apple, apple_id = await check_apple_subscription_by_email(email)
    if has_apple:
        return True, apple_id, "apple", None

    # 2. Check Stripe directly (source of truth)
    found = await asyncio.to_thread(_find_active_stripe_subscription, email)
    if found:
        sub_id, customer_id = found
        return True, sub_id, "stripe", customer_id

    return False, None, None, None


def _find_active_stripe_subscription(email: str) -> tuple[str, str] | None:
    """(subscription_id, customer_id) of the first active/trialing personal subscription. Thread-side."""
    try:
        for cust in _list_personal_customers(email):
            subscriptions = stripe.Subscription.list(customer=cust.id, status='all', limit=100)
            for sub in subscriptions.data:
                if sub.status in ('active', 'trialing'):
                    return sub.id, cust.id
    except Exception as e:
        logger.error(f"Error checking Stripe subscription for {email}: {e}")
    return None


# --- URLs for Redirection ---
DEFAULT_BASE_URL = "https://app.observer-ai.com"
MANAGE_SUBSCRIPTION_RETURN_URL = "https://app.observer-ai.com/refresh"


def is_valid_return_url(url: str | None) -> bool:
    """Allow localhost, tauri, or observer-ai.com origins."""
    if not url:
        return False
    patterns = [
        r'^[a-z]+://localhost(:\d+)?',
        r'^tauri://',
        r'^https?://([^/]+\.)?observer-ai\.com',
    ]
    return any(re.match(pattern, url, re.IGNORECASE) for pattern in patterns)


def get_base_url(client_url: str | None) -> str:
    if client_url and is_valid_return_url(client_url):
        return client_url.rstrip('/')
    return DEFAULT_BASE_URL


# --- Request Models ---
class CheckoutRequest(BaseModel):
    return_base_url: str | None = None


OLD_STRIPE_KEY = os.environ.get("OLD_STRIPE_SECRET_KEY")
if OLD_STRIPE_KEY:
    logger.info("Legacy Stripe key loaded — dual-account mode active.")

logger.info("Payments router initialized successfully.")


def _create_billing_portal(customer_id: str, return_url: str):
    """Try new Stripe first, fall back to legacy Stripe for old customers."""
    try:
        return stripe.billing_portal.Session.create(customer=customer_id, return_url=return_url)
    except stripe.error.InvalidRequestError:
        if OLD_STRIPE_KEY:
            logger.info(f"Customer {customer_id} not found on new Stripe, trying legacy account.")
            return stripe.billing_portal.Session.create(customer=customer_id, return_url=return_url, api_key=OLD_STRIPE_KEY)
        raise


# --- Request Models ---
class TrialLinkRequest(BaseModel):
    """Request model for creating trial links."""
    email: EmailStr


@payments_router.post(
    "/admin/create-trial-link",
    summary="[Admin] Generate 1-Week MAX Trial Link",
    tags=["Admin"]
)
async def create_trial_link(
    request: TrialLinkRequest,
    is_admin: bool = Depends(get_admin_access)
):
    """
    Admin endpoint to generate a Stripe checkout link for a 1-week MAX tier trial.

    - No credit card required
    - Auto-cancels after 7 days if no payment method added
    - Requires X-Admin-Key header for authentication

    Args:
        request: Contains the email address of the trial recipient

    Returns:
        Stripe checkout URL to share with the recipient
    """
    email = request.email.lower()

    # Verify the user exists in Auth0
    user_id = await find_user_by_email(email)
    if not user_id:
        logger.error(f"Admin tried to create trial for non-existent email: {email}")
        raise HTTPException(
            status_code=404,
            detail=f"No Observer user found with email: {email}. User must create an account first."
        )

    # Check if user already has active subscription (source of truth, not stale metadata)
    has_sub, existing_id, provider, _ = await has_active_subscription(email)
    if has_sub:
        logger.warning(f"Admin tried to create trial for {email} but user already has {provider} subscription: {existing_id}")
        raise HTTPException(
            status_code=400,
            detail=f"User already has an active {provider} subscription."
        )

    if not MAX_PRICE_ID:
        logger.error("MAX_PRICE_ID not configured but trial checkout was requested.")
        raise HTTPException(status_code=503, detail="Max tier is not currently available.")

    try:
        checkout_session = await asyncio.to_thread(
            stripe.checkout.Session.create,
            line_items=[{"price": MAX_PRICE_ID, "quantity": 1}],
            mode="subscription",

            # Link to user via email (no need to be logged in)
            customer_email=email,

            # Redirect URLs
            success_url=f"{DEFAULT_BASE_URL}/upgrade-success",
            cancel_url=DEFAULT_BASE_URL,

            # Don't require payment method for $0 trial
            payment_method_collection="if_required",

            # Trial configuration with auto-cancellation
            subscription_data={
                "trial_period_days": 7,
                "trial_settings": {
                    "end_behavior": {
                        "missing_payment_method": "cancel"  # Auto-cancel if no payment added
                    }
                },
                # Store user_id for webhook lookup (backup to email)
                "metadata": {
                    "user_id": user_id,
                    "trial_type": "giveaway"
                }
            }
        )

        logger.info(f"Admin created 7-day MAX trial link for {email} (user_id: {user_id})")
        return {
            "url": checkout_session.url,
            "email": email,
            "expires_at": "Link expires in 24 hours",
            "trial_duration": "7 days",
            "message": "Share this link with the recipient. No credit card required."
        }

    except Exception as e:
        logger.error(f"Trial link creation failed for {email}: {e}")
        raise HTTPException(status_code=500, detail="Could not create trial session.")


# --- Partner Discount Program ---
# Each partner gets their own Stripe coupon (e.g. 50% off, duration=once) plus a
# secret auth code. The code -> coupon mapping is built from env vars, so adding
# a partner is a config change (new env pair + a Stripe coupon), not a code change.
#
# Tracking lives entirely in Stripe — no app-side state. List promotion codes by
# a partner's coupon to get: generated = count, conversions = sum(times_redeemed),
# and each code's `created` timestamp for the generation timeline.
#
# Partners are loaded by convention from env vars, so no brand names live in this
# (open-source) file and adding a partner needs only an .env change + API restart:
#
#   OBSERVER_PARTNER_<ID>_CODE=<secret auth code the partner panel sends>
#   OBSERVER_PARTNER_<ID>_COUPON=<Stripe coupon ID>         (discount codes)
#   OBSERVER_PARTNER_<ID>_ACCOUNT=<Stripe Connect acct_ ID>  (enterprise sales)
#
# <ID> is any token (a codename or a number) and becomes the partner label stored
# in promo-code and subscription metadata. A partner needs at least one of COUPON
# or ACCOUNT. Each partner gets a distinct coupon, so per-partner stats fall out
# of PromotionCode.list(coupon=<that coupon>).
PARTNERS: dict[str, dict[str, str | None]] = {}

_PARTNER_CODE_RE = re.compile(r"^OBSERVER_PARTNER_(.+)_CODE$")


def _load_partners() -> None:
    """Build the code -> partner-config map from OBSERVER_PARTNER_<ID>_* env vars."""
    for env_key, code in os.environ.items():
        match = _PARTNER_CODE_RE.match(env_key)
        if not match:
            continue
        raw_id = match.group(1)
        coupon_id = os.environ.get(f"OBSERVER_PARTNER_{raw_id}_COUPON") or None
        account_id = os.environ.get(f"OBSERVER_PARTNER_{raw_id}_ACCOUNT") or None
        partner_id = raw_id.lower()
        if not code or not (coupon_id or account_id):
            logger.warning(f"Partner '{partner_id}' skipped: needs CODE plus a COUPON or ACCOUNT env var.")
            continue
        PARTNERS[code] = {"id": partner_id, "coupon_id": coupon_id, "account_id": account_id}
        logger.info(f"Partner program enabled for '{partner_id}' "
                    f"(codes={'yes' if coupon_id else 'no'}, enterprise={'yes' if account_id else 'no'}).")

    logger.info(f"Loaded {len(PARTNERS)} partner(s) for the partner program.")


_load_partners()

# How long a generated promo code stays valid before it expires.
PARTNER_CODE_TTL_DAYS = 60

partner_key_header = APIKeyHeader(name="X-Partner-Key", auto_error=False)


async def get_partner(key: str = Security(partner_key_header)) -> dict:
    """
    Dependency that validates the X-Partner-Key header and returns the matching
    partner config ({"id", "coupon_id", "account_id"}). Uses constant-time comparison.
    """
    if key:
        for code, partner in PARTNERS.items():
            if hmac.compare_digest(key, code):
                return partner
    raise HTTPException(status_code=403, detail="You are not authorized to access this resource.")


@payments_router.post(
    "/partner/generate-code",
    summary="[Partner] Generate a single-use discount promotion code",
    tags=["Partner"]
)
async def generate_partner_code(partner: dict = Depends(get_partner)):
    """
    Generate a unique, single-use Stripe promotion code for a partner's lead.

    Auth: X-Partner-Key header (the partner's secret auth code).

    Each generated code:
    - Applies the partner's coupon (e.g. 50% off the first month)
    - Can be redeemed exactly once (max_redemptions=1) — so it cannot be shared/farmed
    - Expires after PARTNER_CODE_TTL_DAYS

    The lead redeems it in the normal checkout via "Add promotion code" (already
    enabled on the Pro/Max checkout sessions). No app frontend changes required.

    Tracking is Stripe-native: PromotionCode.list(coupon=<partner coupon>) gives
    generated count (len) and conversions (sum of times_redeemed).
    """
    coupon_id = partner["coupon_id"]
    partner_id = partner["id"]
    if not coupon_id:
        raise HTTPException(status_code=400, detail="This partner key is not set up for discount codes.")

    try:
        # Newer Stripe API versions nest the coupon under `promotion` instead of a
        # top-level `coupon` param (the latter now 400s as "unknown parameter").
        promo = await asyncio.to_thread(
            stripe.PromotionCode.create,
            promotion={"type": "coupon", "coupon": coupon_id},
            max_redemptions=1,
            expires_at=int(time.time()) + PARTNER_CODE_TTL_DAYS * 24 * 60 * 60,
            metadata={"partner": partner_id},
        )

        # Report the actual discount from the coupon when available (don't hardcode 50%).
        # Handle both shapes: legacy `promo.coupon` and newer `promo.promotion.coupon`.
        discount_label = None
        coupon_obj = getattr(promo, "coupon", None)
        if coupon_obj is None:
            promotion_obj = getattr(promo, "promotion", None)
            coupon_obj = getattr(promotion_obj, "coupon", None) if promotion_obj is not None else None
        percent_off = getattr(coupon_obj, "percent_off", None) if coupon_obj is not None else None
        if percent_off:
            discount_label = f"{percent_off:g}% off first month"

        logger.info(f"Generated promo code {promo.code} for partner '{partner_id}' (coupon {coupon_id})")
        return {
            "code": promo.code,
            "partner": partner_id,
            "discount": discount_label,
            "expires_in_days": PARTNER_CODE_TTL_DAYS,
            "message": "Share this single-use code with your lead. They enter it at checkout.",
        }

    except Exception as e:
        logger.error(f"Failed to generate promo code for partner '{partner_id}': {e}")
        raise HTTPException(status_code=500, detail="Could not generate promotion code.")


# --- Partner Enterprise Sales ---
# A partner with an ACCOUNT closes an enterprise deal by provisioning the org
# from the partner dashboard. Stripe then pays PARTNER_COMMISSION_PERCENT of
# every invoice to their Connect account for PARTNER_COMMISSION_MONTHS and stops
# on its own (orgs._create_commission_schedule).
#
# Stripe is the only record of a deal. The partner's deal list is a live search
# on subscription metadata, the money trail is their Express dashboard, and
# refunds/disputes claw back through the webhook (_claw_back_partner_share).
PARTNER_COMMISSION_PERCENT = 15
PARTNER_COMMISSION_MONTHS = 12
PARTNER_DEFAULT_MONTHLY_CREDITS = 30_000
PARTNER_MAX_TRIAL_DAYS = 30
PARTNER_MAX_DAYS_UNTIL_DUE = 60
PARTNER_DASHBOARD_URL = "https://partner.observer-ai.com"

# Shared mailbox providers say nothing about which company a contact is from,
# so they never count as an existing org's domain.
_SHARED_EMAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
    "msn.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me",
    "protonmail.com", "gmx.com", "zoho.com",
}


class PartnerOrgRequest(BaseModel):
    name: str
    admin_email: EmailStr
    tier: str = "max"
    seats: int
    days_until_due: int = 30
    trial_period_days: int | None = None
    # -1 is an uncapped pool.
    monthly_credits: int = PARTNER_DEFAULT_MONTHLY_CREDITS
    dry_run: bool = False


def _require_enterprise_partner(partner: dict) -> str:
    """The partner's Connect account ID, or 400 for a codes-only partner."""
    if not partner.get("account_id"):
        raise HTTPException(status_code=400, detail="This partner key is not set up for enterprise sales.")
    return partner["account_id"]


def _find_existing_org_for_domain(email: str) -> str | None:
    """
    org_id of an existing org billed to the same company domain, or None.
    This is the whole "who owns the account" rule: the first org created for a
    company is the deal, and a partner cannot re-provision one that exists.
    Thread-side.
    """
    domain = email.rsplit("@", 1)[-1].lower()
    if domain in _SHARED_EMAIL_DOMAINS:
        return None
    customers = stripe.Customer.search(query=f'email~"@{domain}"', limit=100)
    for cust in customers.data:
        org_id = sget(cust.metadata, "org_id")
        if org_id and (cust.email or "").lower().endswith(f"@{domain}"):
            return org_id
    return None


@payments_router.post(
    "/partner/orgs",
    summary="[Partner] Provision an enterprise org for a closed deal",
    tags=["Partner"]
)
async def partner_create_org(body: PartnerOrgRequest, partner: dict = Depends(get_partner)):
    """
    Create the org, its Stripe customer, and an invoiced subscription at the
    standard seat price, with the partner's commission attached.

    The price is never taken from the request: a negotiated price goes through
    the admin endpoint, which is how it gets approved. Pass dry_run=true to get
    the quote without creating anything.
    """
    account_id = _require_enterprise_partner(partner)

    if not body.name.strip():
        raise HTTPException(status_code=400, detail="Company name is required.")
    if not 1 <= body.days_until_due <= PARTNER_MAX_DAYS_UNTIL_DUE:
        raise HTTPException(status_code=400, detail=f"Net days must be between 1 and {PARTNER_MAX_DAYS_UNTIL_DUE}.")
    if body.trial_period_days is not None and not 1 <= body.trial_period_days <= PARTNER_MAX_TRIAL_DAYS:
        raise HTTPException(status_code=400, detail=f"Trial days must be between 1 and {PARTNER_MAX_TRIAL_DAYS}.")
    if body.monthly_credits < -1:
        raise HTTPException(status_code=400, detail="Monthly pool must be a positive number, or -1 for unlimited.")

    price_id = os.environ.get("STRIPE_ENTERPRISE_SEAT_PRICE_ID")
    if not price_id:
        logger.error("STRIPE_ENTERPRISE_SEAT_PRICE_ID is not set but a partner tried to provision an org.")
        raise HTTPException(status_code=503, detail="Enterprise checkout is not currently available.")

    try:
        price, existing_org = await asyncio.gather(
            asyncio.to_thread(stripe.Price.retrieve, price_id),
            asyncio.to_thread(_find_existing_org_for_domain, body.admin_email),
        )
    except Exception as e:
        logger.error(f"Partner '{partner['id']}' org pre-checks failed: {e}")
        raise HTTPException(status_code=502, detail="Could not reach Stripe. Please try again.")

    if existing_org:
        logger.warning(f"Partner '{partner['id']}' tried to provision {body.admin_email}, but {existing_org} exists")
        raise HTTPException(
            status_code=409,
            detail="An organization for this company already exists. Contact Observer if you think this is wrong.",
        )

    unit_amount = sget(price, "unit_amount") or 0
    monthly_total = unit_amount * body.seats
    quote = {
        "currency": price.currency,
        "unit_amount": unit_amount,
        "monthly_total": monthly_total,
        "commission_percent": PARTNER_COMMISSION_PERCENT,
        "monthly_commission": round(monthly_total * PARTNER_COMMISSION_PERCENT / 100),
        "commission_months": PARTNER_COMMISSION_MONTHS,
    }

    org_body = OrgCreateRequest(
        name=body.name.strip(),
        admin_email=body.admin_email,
        tier=body.tier,
        seats=body.seats,
        monthly_credits=body.monthly_credits,
        price_id=price_id,
        days_until_due=body.days_until_due,
        trial_period_days=body.trial_period_days,
        dry_run=body.dry_run,
    )
    result = await provision_org(org_body, partner={
        "id": partner["id"],
        "account_id": account_id,
        "percent": PARTNER_COMMISSION_PERCENT,
        "months": PARTNER_COMMISSION_MONTHS,
    })
    return {**result, "partner": partner["id"], "quote": quote}


def _list_partner_deals(partner_id: str) -> list[dict]:
    """Every subscription a partner provisioned, straight from Stripe. Thread-side."""
    subs = stripe.Subscription.search(
        query=f"metadata['partner']:'{partner_id}'",
        limit=100,
        expand=["data.customer", "data.latest_invoice"],
    )
    deals = []
    for sub in subs.auto_paging_iter():
        customer = sget(sub, "customer")
        invoice = sget(sub, "latest_invoice")
        item = sget(sget(sget(sub, "items"), "data"), 0)
        commission_until = sget(sub.metadata, "commission_until")
        deals.append({
            "org_id": sget(sub.metadata, "org_id"),
            "company": sget(customer, "name"),
            "admin_email": sget(customer, "email"),
            "status": sub.status,
            "seats": sget(item, "quantity"),
            "created": sub.created,
            "commission_until": int(commission_until) if commission_until else None,
            "latest_invoice": {
                "status": sget(invoice, "status"),
                "amount_due": sget(invoice, "amount_due"),
                "amount_paid": sget(invoice, "amount_paid"),
                "currency": sget(invoice, "currency"),
                "hosted_invoice_url": sget(invoice, "hosted_invoice_url"),
            } if invoice else None,
        })
    deals.sort(key=lambda d: d["created"], reverse=True)
    return deals


@payments_router.get(
    "/partner/orgs",
    summary="[Partner] List the orgs this partner provisioned",
    tags=["Partner"]
)
async def partner_list_orgs(partner: dict = Depends(get_partner)):
    _require_enterprise_partner(partner)
    try:
        deals = await asyncio.to_thread(_list_partner_deals, partner["id"])
    except Exception as e:
        logger.error(f"Could not list deals for partner '{partner['id']}': {e}")
        raise HTTPException(status_code=502, detail="Could not load your deals from Stripe.")
    return {
        "partner": partner["id"],
        "commission_percent": PARTNER_COMMISSION_PERCENT,
        "commission_months": PARTNER_COMMISSION_MONTHS,
        "orgs": deals,
    }


def _partner_stripe_link(account_id: str) -> dict:
    """Express dashboard login, or the onboarding flow if it isn't finished. Thread-side."""
    account = stripe.Account.retrieve(account_id)
    if not account.details_submitted:
        link = stripe.AccountLink.create(
            account=account_id,
            refresh_url=PARTNER_DASHBOARD_URL,
            return_url=PARTNER_DASHBOARD_URL,
            type="account_onboarding",
        )
        return {"url": link.url, "kind": "onboarding"}
    link = stripe.Account.create_login_link(account_id)
    return {"url": link.url, "kind": "dashboard"}


@payments_router.post(
    "/partner/stripe-link",
    summary="[Partner] One-time link to the partner's Stripe Express dashboard",
    tags=["Partner"]
)
async def partner_stripe_link(partner: dict = Depends(get_partner)):
    account_id = _require_enterprise_partner(partner)
    try:
        return await asyncio.to_thread(_partner_stripe_link, account_id)
    except Exception as e:
        logger.error(f"Could not create Stripe link for partner '{partner['id']}': {e}")
        raise HTTPException(status_code=502, detail="Could not open Stripe. Please try again.")


def _claw_back_partner_share(event_type: str, obj) -> None:
    """
    Reverse a partner's share of a refunded or disputed payment. A charge with
    no Connect transfer (every non-partner payment) is a no-op. Thread-side.

    Safe under webhook retries. A refund reverses only the gap between the
    partner's share of the total refunded so far and what is already reversed,
    so a refund issued with reverse_transfer=true is a no-op here. A dispute
    reverses under an idempotency key tied to that dispute.
    """
    is_dispute = event_type == "charge.dispute.created"
    charge = stripe.Charge.retrieve(sget(obj, "charge") if is_dispute else sget(obj, "id"), expand=["transfer"])
    transfer = sget(charge, "transfer")
    if not transfer or not charge.amount:
        return

    if is_dispute:
        share = round(transfer.amount * obj.amount / charge.amount)
        amount = min(share, transfer.amount - transfer.amount_reversed)
        idempotency_key = f"partner-dispute-reversal-{obj.id}"
    else:
        share = round(transfer.amount * charge.amount_refunded / charge.amount)
        amount = share - transfer.amount_reversed
        idempotency_key = f"partner-refund-reversal-{charge.id}-{charge.amount_refunded}"

    if amount <= 0:
        return
    stripe.Transfer.create_reversal(transfer.id, amount=amount, idempotency_key=idempotency_key)
    logger.info(f"Reversed {amount} of transfer {transfer.id} to {transfer.destination} after {event_type} on {charge.id}")



def _get_subscription_from_metadata(user: AuthUser) -> tuple[bool, str | None, str | None, str | None]:
    """
    Fast subscription check using JWT app_metadata (kept current by Stripe/Apple webhooks).

    Returns (has_subscription, subscription_id, provider, stripe_customer_id)
    """
    metadata = user.app_metadata if isinstance(getattr(user, 'app_metadata', None), dict) else {}

    apple_id = metadata.get("apple_transaction_id")
    if apple_id:
        return True, apple_id, "apple", None

    stripe_sub_id = metadata.get("stripe_subscription_id")
    stripe_customer_id = metadata.get("stripe_customer_id")
    if stripe_sub_id:
        return True, stripe_sub_id, "stripe", stripe_customer_id

    return False, None, None, None


def get_or_create_stripe_customer(user: AuthUser) -> str | None:
    """
    Get existing Stripe customer ID or create a new one with the Auth0 email.

    This ensures the Stripe customer always has the Auth0 email, preventing
    mismatches from Stripe Link or other payment autofill features that could
    create a customer with a different email.

    Thread-side: call through asyncio.to_thread.
    """
    # Fast path: use cached customer ID from JWT metadata
    if isinstance(getattr(user, 'app_metadata', None), dict):
        cached_id = user.app_metadata.get("stripe_customer_id")
        if cached_id:
            return cached_id

    # Fallback: query Stripe by email (new users who have no metadata yet)
    try:
        if hasattr(user, 'email') and user.email:
            existing_customers = _list_personal_customers(user.email)
            if existing_customers:
                return existing_customers[0].id
    except Exception as e:
        logger.warning(f"Stripe customer lookup failed for {user.id}: {e}")

    # No existing customer found — create one with the Auth0 email
    # so that Stripe Link cannot override it with a different email
    try:
        new_customer = stripe.Customer.create(
            email=user.email,
            metadata={"auth0_user_id": user.id}
        )
        logger.info(f"Created new Stripe customer {new_customer.id} for user {user.id} ({user.email})")
        return new_customer.id
    except Exception as e:
        logger.error(f"Failed to create Stripe customer for {user.id}: {e}")
        return None


@payments_router.post(
    "/create-checkout-session",
    summary="Create Stripe Checkout Session for New Subscription"
)
async def create_checkout_session(current_user: AuthUser, body: CheckoutRequest = None):
    """
    Creates a Stripe Checkout session for the currently authenticated user to
    purchase the Pro plan. The user's Auth0 ID is passed to Stripe for
    identification in webhooks.
    """
    reject_if_org_member(current_user)

    base_url = get_base_url(body.return_base_url if body else None)

    has_sub, existing_id, provider, active_customer_id = _get_subscription_from_metadata(current_user)
    if has_sub:
        if provider == "apple":
            raise HTTPException(
                status_code=400,
                detail="You have an active Apple subscription. Please cancel it in iOS Settings before purchasing via Stripe."
            )
        elif provider == "stripe" and active_customer_id:
            portal = await asyncio.to_thread(
                stripe.billing_portal.Session.create,
                customer=active_customer_id,
                return_url=f"{base_url}/refresh",
            )
            return {"url": portal.url, "redirect": "portal"}

    try:
        # Get or create Stripe customer with Auth0 email to prevent Link email mismatch
        customer_id = await asyncio.to_thread(get_or_create_stripe_customer, current_user)

        # Check if user has already used a free trial
        had_trial = await asyncio.to_thread(_had_trial, current_user, customer_id)

        checkout_params = {
            "line_items": [{"price": PRO_PRICE_ID, "quantity": 1}],
            "mode": "subscription",
            "client_reference_id": current_user.id,
            "success_url": f"{base_url}/upgrade-success",
            "cancel_url": base_url,
            "allow_promotion_codes": True,
        }

        if not had_trial:
            checkout_params["subscription_data"] = {"trial_period_days": 7}

        if customer_id:
            checkout_params["customer"] = customer_id

        checkout_session = await asyncio.to_thread(stripe.checkout.Session.create, **checkout_params)
        return {"url": checkout_session.url}
    except Exception as e:
        logger.error(f"Stripe Checkout creation failed for user {current_user.id}: {e}")
        raise HTTPException(status_code=500, detail="Could not create payment session.")


def _had_trial(user: AuthUser, customer_id: str | None) -> bool:
    """
    Whether this user has already used a free trial, on their current customer
    or on a ghost customer left by a deleted account with the same email.
    Thread-side: call through asyncio.to_thread.
    """
    had_trial = False
    if customer_id:
        try:
            past_subs = stripe.Subscription.list(customer=customer_id, status='all', limit=100)
            had_trial = any(sub.trial_end is not None for sub in past_subs.data)
        except Exception as e:
            logger.warning(f"Failed to check trial history for {user.id}: {e}")

    # Check ghost customers — accounts that were deleted and re-registered with the same email
    if not had_trial and hasattr(user, 'email') and user.email:
        try:
            email_hash = hashlib.sha256(user.email.lower().encode()).hexdigest()
            ghost_customers = stripe.Customer.list(email=f"{email_hash}@deleted.invalid", limit=100)
            for ghost in ghost_customers.data:
                past_subs = stripe.Subscription.list(customer=ghost.id, status='all', limit=100)
                if any(sub.trial_end is not None for sub in past_subs.data):
                    had_trial = True
                    break
        except Exception as e:
            logger.warning(f"Failed to check ghost trial history for {user.id}: {e}")

    return had_trial


@payments_router.post(
    "/create-checkout-session-max",
    summary="Create Stripe Checkout Session for Max Subscription"
)
async def create_checkout_session_max(current_user: AuthUser, body: CheckoutRequest = None):
    """
    Creates a Stripe Checkout session for the currently authenticated user to
    purchase the Max plan. The user's Auth0 ID is passed to Stripe for
    identification in webhooks.
    """
    reject_if_org_member(current_user)

    base_url = get_base_url(body.return_base_url if body else None)

    has_sub, existing_id, provider, active_customer_id = _get_subscription_from_metadata(current_user)
    if has_sub:
        if provider == "apple":
            raise HTTPException(
                status_code=400,
                detail="You have an active Apple subscription. Please cancel it in iOS Settings before purchasing via Stripe."
            )
        elif provider == "stripe" and active_customer_id:
            portal = await asyncio.to_thread(
                stripe.billing_portal.Session.create,
                customer=active_customer_id,
                return_url=f"{base_url}/refresh",
            )
            return {"url": portal.url, "redirect": "portal"}

    if not MAX_PRICE_ID:
        logger.error("MAX_PRICE_ID not configured but Max checkout was requested.")
        raise HTTPException(status_code=503, detail="Max tier is not currently available.")

    try:
        # Get or create Stripe customer with Auth0 email to prevent Link email mismatch
        customer_id = await asyncio.to_thread(get_or_create_stripe_customer, current_user)

        checkout_params = {
            "line_items": [{"price": MAX_PRICE_ID, "quantity": 1}],
            "mode": "subscription",
            "client_reference_id": current_user.id,
            "success_url": f"{base_url}/upgrade-success",
            "cancel_url": base_url,
            "allow_promotion_codes": True,
        }

        if customer_id:
            checkout_params["customer"] = customer_id

        checkout_session = await asyncio.to_thread(stripe.checkout.Session.create, **checkout_params)
        return {"url": checkout_session.url}
    except Exception as e:
        logger.error(f"Stripe Checkout creation failed for Max tier for user {current_user.id}: {e}")
        raise HTTPException(status_code=500, detail="Could not create payment session.")


@payments_router.post(
    "/create-checkout-session-plus",
    summary="Create Stripe Checkout Session for Plus Subscription"
)
async def create_checkout_session_plus(current_user: AuthUser, body: CheckoutRequest = None):
    """
    Creates a Stripe Checkout session for the currently authenticated user to
    purchase the Plus plan. The user's Auth0 ID is passed to Stripe for
    identification in webhooks.
    """
    reject_if_org_member(current_user)

    base_url = get_base_url(body.return_base_url if body else None)

    has_sub, existing_id, provider, active_customer_id = _get_subscription_from_metadata(current_user)
    if has_sub:
        if provider == "apple":
            raise HTTPException(
                status_code=400,
                detail="You have an active Apple subscription. Please cancel it in iOS Settings before purchasing via Stripe."
            )
        elif provider == "stripe" and active_customer_id:
            portal = await asyncio.to_thread(
                stripe.billing_portal.Session.create,
                customer=active_customer_id,
                return_url=f"{base_url}/refresh",
            )
            return {"url": portal.url, "redirect": "portal"}

    if not PLUS_PRICE_ID:
        logger.error("PLUS_PRICE_ID not configured but Plus checkout was requested.")
        raise HTTPException(status_code=503, detail="Plus tier is not currently available.")

    try:
        # Get or create Stripe customer with Auth0 email to prevent Link email mismatch
        customer_id = await asyncio.to_thread(get_or_create_stripe_customer, current_user)

        checkout_params = {
            "line_items": [{"price": PLUS_PRICE_ID, "quantity": 1}],
            "mode": "subscription",
            "client_reference_id": current_user.id,
            "success_url": f"{base_url}/upgrade-success",
            "cancel_url": base_url,
            "allow_promotion_codes": True,
        }

        if customer_id:
            checkout_params["customer"] = customer_id

        checkout_session = await asyncio.to_thread(stripe.checkout.Session.create, **checkout_params)
        return {"url": checkout_session.url}
    except Exception as e:
        logger.error(f"Stripe Checkout creation failed for Plus tier for user {current_user.id}: {e}")
        raise HTTPException(status_code=500, detail="Could not create payment session.")


@payments_router.post(
    "/create-customer-portal-session",
    summary="Create Stripe Customer Portal Session for Management"
)
# CORRECTED LINE: Removed '= Depends(AuthUser)'
async def create_customer_portal_session(current_user: AuthUser, body: CheckoutRequest = None):
    """
    Creates a Stripe Customer Portal session, allowing the user to manage their
    billing information, invoices, and cancel their subscription.
    """
    base_url = get_base_url(body.return_base_url if body else None)

    has_sub, existing_id, provider, customer_id = _get_subscription_from_metadata(current_user)

    if not has_sub:
        raise HTTPException(status_code=404, detail="No active subscription found to manage.")

    if provider == "apple":
        raise HTTPException(
            status_code=400,
            detail="Your subscription is managed through Apple. Please manage it in iOS Settings > Subscriptions."
        )

    if not customer_id:
        raise HTTPException(status_code=404, detail="No active subscription found to manage.")

    try:
        portal_session = await asyncio.to_thread(_create_billing_portal, customer_id, f"{base_url}/refresh")
        return {"url": portal_session.url}
    except Exception as e:
        logger.error(f"Could not create customer portal for user {current_user.id}: {e}")
        raise HTTPException(status_code=500, detail="Could not create customer portal session.")


async def sync_user_from_stripe(stripe_customer_id: str) -> dict:
    """
    Single idempotent function to sync a user's subscription state from Stripe to Auth0.

    Uses EMAIL as the link between Stripe and Auth0 (not customer ID), so it finds
    ALL Stripe customers for the user's email and checks ALL their subscriptions.
    This prevents cancelling one duplicate customer from overriding an active sub on another.

    Safe to call multiple times - always produces the same result for the same Stripe state.

    Args:
        stripe_customer_id: The Stripe customer ID (from webhook event)

    Returns:
        dict with status, user_id, and subscription info
    """
    # 1. Get the email from the triggering Stripe customer (source of truth)
    try:
        customer = await asyncio.to_thread(stripe.Customer.retrieve, stripe_customer_id)
        customer_email = customer.email
    except Exception as e:
        logger.error(f"Could not retrieve Stripe customer {stripe_customer_id}: {e}")
        return {"status": "error", "detail": "Failed to retrieve Stripe customer"}

    if not customer_email:
        logger.error(f"Stripe customer {stripe_customer_id} has no email")
        return {"status": "error", "detail": "Customer has no email"}

    # 2. Find the Auth0 user by email (email is the canonical link)
    user_id = await find_user_by_email(customer_email)
    if not user_id:
        # Fallback: try by stripe_customer_id in Auth0 metadata
        user_id = await find_user_by_stripe_customer_id(stripe_customer_id)

    if not user_id:
        logger.error(f"sync_user_from_stripe: Cannot find Auth0 user for email {customer_email} or stripe_customer_id {stripe_customer_id}")
        return {"status": "error", "detail": "User not found"}

    # Enterprise seat holders are entitled by their org, not by anything under
    # their own email. Without this guard, any Stripe event touching a lapsed
    # personal customer of theirs would find no active subscription and clear
    # the is_pro flag their org granted.
    seat_metadata = await get_user_app_metadata(user_id)
    if seat_metadata.get("org_id"):
        logger.info(f"Skipping Stripe sync for {user_id}: entitled by org {seat_metadata['org_id']}")
        return {"status": "skipped", "user_id": user_id, "reason": "org-entitled"}

    # 3. Find ALL Stripe customers with this email
    try:
        all_customers = await asyncio.to_thread(stripe.Customer.list, email=customer_email, limit=100)
    except Exception as e:
        logger.error(f"Failed to list Stripe customers for email {customer_email}: {e}")
        return {"status": "error", "detail": "Failed to query Stripe customers"}

    if len(all_customers.data) > 1:
        cust_ids = [c.id for c in all_customers.data]
        logger.warning(f"USER HAS MULTIPLE STRIPE CUSTOMERS: email={customer_email}, user_id={user_id}, customer_ids={cust_ids}")

    # 4. Query ALL subscriptions across ALL customers for this email
    is_pro, is_max, is_plus = False, False, False
    active_subscription_id = None
    active_customer_id = None
    total_active = 0

    for cust in all_customers.data:
        # An enterprise org's Stripe customer is created with the billing
        # contact's email, so it shows up in this list for that person. Its
        # subscription bills the company, not them — counting it here would
        # price the whole company's seats as if they were a personal plan.
        if sget(cust.metadata, "org_id"):
            logger.info(f"Skipping org-owned customer {cust.id} while syncing user {user_id}")
            continue

        try:
            subscriptions = await asyncio.to_thread(stripe.Subscription.list, customer=cust.id, limit=100)
        except Exception as e:
            logger.error(f"Failed to list subscriptions for customer {cust.id}: {e}")
            continue

        for sub in subscriptions.data:
            if sub.status in ("active", "trialing"):
                total_active += 1

                try:
                    price_id = sub["items"]["data"][0]["price"]["id"]
                    sub_is_pro, sub_is_max, sub_is_plus = get_tier_from_price(price_id)

                    # Accumulate flags (highest tier wins)
                    is_pro = is_pro or sub_is_pro
                    is_max = is_max or sub_is_max
                    is_plus = is_plus or sub_is_plus

                    # Track subscription/customer ID (prefer max > pro > plus)
                    if sub_is_max or (sub_is_pro and not is_max) or (sub_is_plus and not is_pro and not is_max):
                        active_subscription_id = sub.id
                        active_customer_id = cust.id

                except (KeyError, IndexError) as e:
                    logger.error(f"Cannot extract price from subscription {sub.id}: {e}")

    if total_active > 1:
        logger.warning(f"USER HAS MULTIPLE ACTIVE SUBSCRIPTIONS: user_id={user_id}, email={customer_email}, count={total_active}")

    # 5. Determine final state description for logging
    if is_max:
        tier_name = "Max"
    elif is_pro:
        tier_name = "Pro"
    elif is_plus:
        tier_name = "Plus"
    else:
        tier_name = "Free"

    logger.info(f"Syncing user {user_id} to {tier_name} (active_subs={total_active}, is_pro={is_pro}, is_max={is_max}, is_plus={is_plus})")

    # 6. Update Auth0
    # Store the customer ID that has the active subscription (or keep triggering ID if none active)
    # Clear stripe_subscription_id when no active subscription
    await update_user_subscription_status(
        user_id=user_id,
        is_pro=is_pro,
        is_max=is_max,
        is_plus=is_plus,
        stripe_customer_id=active_customer_id if active_customer_id else stripe_customer_id,
        stripe_subscription_id=active_subscription_id if active_subscription_id else CLEAR_FIELD
    )

    return {
        "status": "success",
        "user_id": user_id,
        "tier": tier_name,
        "active_subscriptions": total_active,
        "is_pro": is_pro,
        "is_max": is_max,
        "is_plus": is_plus
    }


@payments_router.post(
    "/sync-subscription",
    summary="Sync subscription status from Stripe"
)
async def sync_subscription_endpoint(current_user: AuthUser):
    """
    Manually sync the user's subscription status from Stripe.

    Call this when:
    - User returns from Stripe Customer Portal
    - User reports their subscription status is wrong
    - After any subscription change to ensure consistency

    Returns the synced subscription state.
    """
    # Find user's Stripe customer ID (prefer Auth0 metadata, fall back to email lookup)
    stripe_customer_id = None
    if hasattr(current_user, 'app_metadata') and isinstance(current_user.app_metadata, dict):
        stripe_customer_id = current_user.app_metadata.get("stripe_customer_id")

    if not stripe_customer_id and hasattr(current_user, 'email') and current_user.email:
        try:
            customers = await asyncio.to_thread(_list_personal_customers, current_user.email)
            if customers:
                stripe_customer_id = customers[0].id
        except Exception as e:
            logger.warning(f"Stripe customer lookup by email failed for {current_user.id}: {e}")

    if not stripe_customer_id:
        logger.info(f"User {current_user.id} requested sync but no Stripe customer found")
        return {
            "status": "success",
            "tier": "Free",
            "message": "No subscription found"
        }

    result = await sync_user_from_stripe(stripe_customer_id)
    return result


@payments_router.post(
    "/webhooks/stripe",
    summary="Stripe Webhook Handler (Public)",
    include_in_schema=False
)
async def stripe_webhook(request: Request, stripe_signature: str = Header(None)):
    """
    Listens for events from Stripe and syncs user subscription status to Auth0.

    Architecture: All subscription events trigger the same sync function.
    The sync function queries Stripe for current state - it doesn't trust
    the webhook payload for determining final user state.
    """
    payload = await request.body()
    try:
        event = stripe.Webhook.construct_event(
            payload=payload, sig_header=stripe_signature, secret=WEBHOOK_SECRET
        )
    except (ValueError, stripe.error.SignatureVerificationError) as e:
        logger.warning(f"Invalid Stripe webhook signature: {e}")
        raise HTTPException(status_code=400, detail="Invalid webhook signature.")

    event_type = event['type']
    event_data = event['data']['object']
    logger.info(f"Received Stripe webhook: {event_type}")

    # Events that trigger a sync from Stripe (source of truth)
    SYNC_EVENTS = {
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.payment_failed',
    }

    # A refund or dispute on a partner deal takes back the partner's share. Those
    # charges belong to org customers, which the routing below would swallow,
    # so this runs first. Errors propagate: a 500 makes Stripe retry, and the
    # reversal is idempotent.
    if event_type in ('charge.refunded', 'charge.dispute.created'):
        await asyncio.to_thread(_claw_back_partner_share, event_type, event_data)
        return {"status": "success"}

    # Enterprise orgs are billed on a customer carrying an org_id in metadata.
    # Route those away from the per-user path entirely: that path resolves the
    # billing contact's email to an Auth0 user and would rewrite their personal
    # entitlement from the company's subscription.
    event_customer_id = getattr(event_data, 'customer', None)
    if event_customer_id:
        try:
            org_customer = await asyncio.to_thread(stripe.Customer.retrieve, event_customer_id)
            org_id = sget(org_customer.metadata, "org_id")
        except Exception as e:
            logger.error(f"Could not retrieve customer {event_customer_id} for org routing: {e}")
            org_id = None

        if org_id:
            if event_type in SYNC_EVENTS:
                return await sync_org_from_stripe(org_id)
            logger.info(f"Ignoring event {event_type} for org {org_id}")
            return {"status": "ignored", "org_id": org_id}

    # Handle checkout.session.completed — safety net for email mismatches.
    # If Stripe Link changed the customer email, fix it using client_reference_id (Auth0 user ID).
    if event_type == 'checkout.session.completed':
        stripe_customer_id = getattr(event_data, 'customer', None)
        client_ref_id = getattr(event_data, 'client_reference_id', None)
        if stripe_customer_id and client_ref_id:
            try:
                customer = await asyncio.to_thread(stripe.Customer.retrieve, stripe_customer_id)
                # Look up the Auth0 user's email from client_reference_id
                auth0_email = ((await get_email_by_id(client_ref_id)) or '').lower()
                customer_email = (customer.email or '').lower()

                if auth0_email and customer_email and auth0_email != customer_email:
                    logger.warning(
                        f"Stripe customer {stripe_customer_id} email ({customer_email}) "
                        f"doesn't match Auth0 user {client_ref_id} email ({auth0_email}). "
                        f"Updating Stripe customer email."
                    )
                    await asyncio.to_thread(stripe.Customer.modify, stripe_customer_id, email=auth0_email)
            except Exception as e:
                logger.error(f"Failed to verify/fix customer email on checkout.session.completed: {e}")

        # Backfill customer name and address from checkout session details.
        # Since we pre-create the customer with only an email, Stripe doesn't
        # have name/address until the user fills them in during checkout.
        if stripe_customer_id:
            try:
                customer_details = getattr(event_data, 'customer_details', None)
                update_fields = {}

                if customer_details:
                    name = getattr(customer_details, 'name', None)
                    if name:
                        update_fields['name'] = name

                    address = getattr(customer_details, 'address', None)
                    if address:
                        update_fields['address'] = address

                if update_fields:
                    await asyncio.to_thread(stripe.Customer.modify, stripe_customer_id, **update_fields)
                    logger.info(f"Backfilled customer {stripe_customer_id} with checkout details: {list(update_fields.keys())}")
            except Exception as e:
                logger.error(f"Failed to backfill customer details for {stripe_customer_id}: {e}")

        # Also trigger a sync for this customer
        if stripe_customer_id:
            result = await sync_user_from_stripe(stripe_customer_id)
            return result
        return {"status": "success"}

    # Get customer ID from event
    stripe_customer_id = getattr(event_data, 'customer', None)

    if event_type in SYNC_EVENTS and stripe_customer_id:
        result = await sync_user_from_stripe(stripe_customer_id)
        return result

    logger.info(f"Ignoring Stripe event: {event_type}")
    return {"status": "success"}
