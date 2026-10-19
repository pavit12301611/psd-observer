# apple_payments.py
# Apple In-App Purchase (StoreKit 2) payment handling

import os
import logging
import json
import time
import base64
import httpx
import jwt
from jwt import PyJWKClient
from fastapi import APIRouter, Request, HTTPException, Depends
from pydantic import BaseModel
from cryptography import x509
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import ec as _ec
from cryptography.hazmat.backends import default_backend
from cryptography.exceptions import InvalidSignature

# --- Project-specific Imports ---
from auth import AuthUser
from auth0_manager import (
    update_user_subscription_status,
    find_user_by_apple_transaction_id,
    get_user_app_metadata,
    check_existing_subscription,
    CLEAR_FIELD
)
from payments import has_active_subscription

# --- Standard Setup ---
logger = logging.getLogger(__name__)
apple_payments_router = APIRouter()

# --- Configuration from Environment Variables ---
APPLE_BUNDLE_ID = os.environ.get("APPLE_BUNDLE_ID")

# Product ID to tier mapping
APPLE_PRO_PRODUCT_ID = os.environ.get("APPLE_PRO_PRODUCT_ID")  # e.g., "com.observer.pro.monthly"
APPLE_MAX_PRODUCT_ID = os.environ.get("APPLE_MAX_PRODUCT_ID")  # e.g., "com.observer.max.monthly"
APPLE_PLUS_PRODUCT_ID = os.environ.get("APPLE_PLUS_PRODUCT_ID")  # e.g., "com.observer.plus.monthly"

# Apple's JWKS URL for verifying signed transactions
# Production: https://appleid.apple.com/auth/keys
# Sandbox: Same URL works for both
APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"

# Cache for Apple's public keys
_jwk_client = None


def _get_jwk_client() -> PyJWKClient:
    """Get or create the JWK client for Apple's public keys."""
    global _jwk_client
    if _jwk_client is None:
        _jwk_client = PyJWKClient(APPLE_JWKS_URL)
    return _jwk_client


def get_tier_from_apple_product(product_id: str) -> tuple[bool, bool, bool]:
    """
    Returns (is_pro, is_max, is_plus) for a given Apple product_id.
    """
    if product_id == APPLE_MAX_PRODUCT_ID:
        return (True, True, False)  # Max users are also pro
    elif product_id == APPLE_PRO_PRODUCT_ID:
        return (True, False, False)
    elif product_id == APPLE_PLUS_PRODUCT_ID:
        return (False, False, True)
    else:
        logger.warning(f"Unknown Apple product_id: {product_id}")
        return (False, False, False)


# Apple Root CA - G3 SHA-256 fingerprint (no separators, lowercase)
# Source: https://www.apple.com/certificateauthority/
_APPLE_ROOT_CA_G3_FINGERPRINT = "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179"


def _validate_apple_cert_chain(cert_chain_b64: list) -> x509.Certificate:
    """
    Validate the x5c certificate chain from an Apple JWS.
    Pins the root against Apple Root CA G3 and verifies each link in the chain.
    Returns the leaf certificate on success; raises ValueError on failure.
    """
    if len(cert_chain_b64) < 3:
        raise ValueError(f"Expected 3 certificates in Apple x5c chain, got {len(cert_chain_b64)}")

    certs = [
        x509.load_der_x509_certificate(base64.b64decode(c), default_backend())
        for c in cert_chain_b64
    ]

    # Pin root against the known Apple Root CA G3 fingerprint
    root_fp = certs[-1].fingerprint(hashes.SHA256()).hex()
    if root_fp != _APPLE_ROOT_CA_G3_FINGERPRINT:
        raise ValueError(f"Root CA is not Apple Root CA G3 (got: {root_fp})")

    # Verify each cert's signature was produced by the next cert in the chain
    for i in range(len(certs) - 1):
        child, parent = certs[i], certs[i + 1]
        try:
            parent.public_key().verify(
                child.signature,
                child.tbs_certificate_bytes,
                _ec.ECDSA(child.signature_hash_algorithm),
            )
        except InvalidSignature:
            raise ValueError(f"Certificate {i} was not signed by certificate {i + 1}")

    return certs[0]


def verify_and_decode_jws(signed_payload: str) -> dict:
    """
    Verify and decode a JWS signed by Apple (StoreKit 2 transaction or notification).

    Apple StoreKit 2 uses certificate chain validation (x5c header), not JWKS.
    The certificate chain is embedded in the JWS header and must be validated
    against Apple's root CA.

    Args:
        signed_payload: The JWS string from Apple (signedTransactionInfo, signedRenewalInfo, etc.)

    Returns:
        Decoded payload as dict

    Raises:
        ValueError: If verification fails
    """
    try:
        # DEBUG: Log the JWS format
        segment_count = signed_payload.count('.') + 1 if signed_payload else 0
        logger.info(f"Verifying JWS: length={len(signed_payload) if signed_payload else 0}, "
                   f"segments={segment_count}, first_50_chars={signed_payload[:50] if signed_payload else 'EMPTY'}")

        # Decode the header to check for x5c (certificate chain)
        header = jwt.get_unverified_header(signed_payload)
        logger.debug(f"JWS Header keys: {list(header.keys())}")

        # StoreKit 2 JWS uses x5c (certificate chain), not kid
        if 'x5c' in header:
            # Extract the certificate chain from the header
            cert_chain = header['x5c']
            if not cert_chain:
                raise ValueError("Empty x5c certificate chain")

            # Validate the chain is rooted at Apple Root CA G3 before trusting any key.
            # Without this check an attacker could forge a JWS with a self-signed cert.
            leaf_cert = _validate_apple_cert_chain(cert_chain)

            # Convert to PEM format for PyJWT
            public_key_pem = leaf_cert.public_key().public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo
            )

            # Decode and verify the JWS using the certificate's public key
            # StoreKit 2 JWS doesn't have an audience claim, so don't verify it
            decoded = jwt.decode(
                signed_payload,
                public_key_pem,
                algorithms=["ES256"],
                options={"verify_aud": False}  # StoreKit 2 doesn't use aud claim
            )

            logger.info(f"Successfully verified JWS: originalTransactionId={decoded.get('originalTransactionId')}, "
                       f"productId={decoded.get('productId')}, bundleId={decoded.get('bundleId')}")
            return decoded

        else:
            # Fallback for App Store Server Notifications V2 which might use kid
            # (though they also typically use x5c)
            logger.warning("JWS missing x5c header, attempting JWKS verification")
            jwk_client = _get_jwk_client()
            signing_key = jwk_client.get_signing_key_from_jwt(signed_payload)

            decoded = jwt.decode(
                signed_payload,
                signing_key.key,
                algorithms=["ES256"],
                options={"verify_aud": False}
            )
            return decoded

    except jwt.exceptions.InvalidTokenError as e:
        logger.error(f"Failed to verify Apple JWS: {e}")
        raise ValueError(f"Invalid Apple signed payload: {e}")
    except Exception as e:
        logger.error(f"Unexpected error verifying JWS: {e}")
        raise ValueError(f"Failed to verify JWS: {e}")


# --- Request Models ---
class VerifyTransactionRequest(BaseModel):
    """Request model for verifying an Apple transaction."""
    signed_transaction: str  # The JWS signedTransactionInfo from StoreKit 2


class AppleNotificationPayload(BaseModel):
    """App Store Server Notification V2 payload."""
    signedPayload: str


# --- Endpoints ---

@apple_payments_router.post(
    "/apple/verify-transaction",
    summary="Verify Apple StoreKit 2 Transaction"
)
async def verify_apple_transaction(
    request: VerifyTransactionRequest,
    current_user: AuthUser
):
    """
    Verify a StoreKit 2 signed transaction and activate the user's subscription.

    Called by the iOS app after a successful purchase. The app sends the
    signedTransactionInfo JWS, which we verify and use to update Auth0.

    Flow:
    1. iOS app completes purchase via StoreKit 2
    2. App gets Transaction.currentEntitlement or purchase result
    3. App calls this endpoint with signedTransactionInfo
    4. We verify the JWS, extract subscription info, update Auth0
    5. Return success - app can refresh user's token
    """
    # DEBUG: Log what we received
    logger.info(f"verify-transaction called by user {current_user.id}")
    logger.info(f"Received signed_transaction: type={type(request.signed_transaction)}, "
                f"length={len(request.signed_transaction) if request.signed_transaction else 0}, "
                f"is_empty={not request.signed_transaction or request.signed_transaction.strip() == ''}")

    # Validate the signed_transaction is not empty
    if not request.signed_transaction or request.signed_transaction.strip() == "":
        logger.error(f"User {current_user.id} sent empty signed_transaction")
        raise HTTPException(
            status_code=400,
            detail="Empty signed_transaction - ensure your app is sending the jwsRepresentation from StoreKit"
        )

    # Verify and decode the signed transaction first (need transaction ID for comparison)
    try:
        transaction = verify_and_decode_jws(request.signed_transaction)
    except ValueError as e:
        logger.error(f"Apple transaction verification failed for user {current_user.id}: {e}")
        raise HTTPException(
            status_code=400,
            detail=f"Invalid transaction signature: {str(e)}. Ensure you're sending the jwsRepresentation from StoreKit."
        )

    # Extract key fields from transaction
    original_transaction_id = transaction.get("originalTransactionId")
    product_id = transaction.get("productId")
    bundle_id = transaction.get("bundleId")
    expires_date_ms = transaction.get("expiresDate")  # milliseconds since epoch
    revocation_date = transaction.get("revocationDate")

    logger.info(f"Apple verify-transaction: user={current_user.id}, email={current_user.email}, "
                f"originalTransactionId={original_transaction_id}, productId={product_id}")

    # Check if user already has a DIFFERENT subscription (source of truth, not stale JWT)
    # Same transaction ID = re-verification of existing sub (StoreKit can fire multiple times)
    has_sub, existing_id, provider, _ = await has_active_subscription(current_user.email)
    duplicate_warning = None
    if has_sub and existing_id != original_transaction_id:
        logger.warning(f"User {current_user.id} activating Apple subscription while having active {provider} subscription: {existing_id}")
        if provider == "stripe":
            duplicate_warning = "You also have an active Stripe subscription. Please cancel one to avoid double-billing."
        elif provider == "apple":
            duplicate_warning = "You already have another active Apple subscription. You may want to cancel the duplicate."

    # Validate bundle ID
    if APPLE_BUNDLE_ID and bundle_id != APPLE_BUNDLE_ID:
        logger.error(f"Bundle ID mismatch: expected {APPLE_BUNDLE_ID}, got {bundle_id}")
        raise HTTPException(status_code=400, detail="Invalid bundle ID")

    # Check if subscription is revoked
    if revocation_date:
        logger.warning(f"Transaction {original_transaction_id} has been revoked")
        raise HTTPException(status_code=400, detail="This subscription has been revoked")

    # Check if subscription is expired
    if expires_date_ms:
        expires_at = expires_date_ms / 1000  # Convert to seconds
        if expires_at < time.time():
            logger.warning(f"Transaction {original_transaction_id} is expired")
            raise HTTPException(status_code=400, detail="This subscription has expired")

    # Determine tier from product ID
    is_pro, is_max, is_plus = get_tier_from_apple_product(product_id)

    if not (is_pro or is_max or is_plus):
        logger.error(f"Unknown product_id in Apple transaction: {product_id}")
        raise HTTPException(status_code=400, detail="Unknown subscription product")

    # Determine tier name for logging
    if is_max:
        tier_name = "Max"
    elif is_pro:
        tier_name = "Pro"
    else:
        tier_name = "Plus"

    logger.info(f"Activating {tier_name} subscription for user {current_user.id} via Apple (transaction: {original_transaction_id})")

    # Update Auth0 with subscription status
    success = await update_user_subscription_status(
        user_id=current_user.id,
        is_pro=is_pro,
        is_max=is_max,
        is_plus=is_plus,
        apple_original_transaction_id=original_transaction_id
    )

    if not success:
        logger.error(f"Failed to update Auth0 for user {current_user.id}")
        raise HTTPException(status_code=500, detail="Failed to activate subscription")

    response = {
        "status": "success",
        "tier": tier_name,
        "original_transaction_id": original_transaction_id,
        "message": "Subscription activated. Please refresh your session to get updated access."
    }
    if duplicate_warning:
        response["warning"] = duplicate_warning
    return response


async def sync_user_from_apple(original_transaction_id: str, transaction_info: dict) -> dict:
    """
    Sync a user's subscription state from Apple transaction info to Auth0.

    This is the Apple equivalent of sync_user_from_stripe().
    Called by webhooks when subscription state changes.

    Args:
        original_transaction_id: The stable identifier for the subscription
        transaction_info: Decoded transaction data from Apple

    Returns:
        dict with status and updated info
    """
    # Find user by Apple transaction ID
    user_id = await find_user_by_apple_transaction_id(original_transaction_id)

    if not user_id:
        logger.error(f"sync_user_from_apple: Cannot find user for original_transaction_id {original_transaction_id}")
        return {"status": "error", "detail": "User not found"}

    # Extract subscription state from transaction
    product_id = transaction_info.get("productId")
    expires_date_ms = transaction_info.get("expiresDate")
    revocation_date = transaction_info.get("revocationDate")

    # Check if subscription is still active
    is_active = True

    if revocation_date:
        is_active = False
        logger.info(f"Subscription {original_transaction_id} was revoked")

    if expires_date_ms:
        expires_at = expires_date_ms / 1000
        if expires_at < time.time():
            is_active = False
            logger.info(f"Subscription {original_transaction_id} has expired")

    # Determine tier
    if is_active:
        is_pro, is_max, is_plus = get_tier_from_apple_product(product_id)
    else:
        is_pro, is_max, is_plus = False, False, False

    # Determine tier name for logging
    if is_max:
        tier_name = "Max"
    elif is_pro:
        tier_name = "Pro"
    elif is_plus:
        tier_name = "Plus"
    else:
        tier_name = "Free"

    logger.info(f"Syncing user {user_id} to {tier_name} from Apple (active={is_active})")

    # Update Auth0
    # IMPORTANT: Clear apple_original_transaction_id when subscription ends
    # This field being present = active subscription (source of truth for blocking duplicate purchases)
    await update_user_subscription_status(
        user_id=user_id,
        is_pro=is_pro,
        is_max=is_max,
        is_plus=is_plus,
        apple_original_transaction_id=original_transaction_id if is_active else CLEAR_FIELD
    )

    return {
        "status": "success",
        "user_id": user_id,
        "tier": tier_name,
        "is_active": is_active,
        "is_pro": is_pro,
        "is_max": is_max,
        "is_plus": is_plus
    }


@apple_payments_router.post(
    "/webhooks/apple",
    summary="Apple App Store Server Notification V2 Handler",
    include_in_schema=False
)
async def apple_webhook(request: Request):
    """
    Handle App Store Server Notifications V2 from Apple.

    Apple sends signed notifications (JWS) for subscription lifecycle events:
    - SUBSCRIBED: New subscription
    - DID_RENEW: Subscription renewed
    - DID_CHANGE_RENEWAL_STATUS: Auto-renew toggled
    - DID_CHANGE_RENEWAL_PREF: Plan changed
    - EXPIRED: Subscription expired
    - GRACE_PERIOD_EXPIRED: Grace period ended
    - REVOKE: Refund or family sharing revocation

    All events trigger a sync from the signed transaction data.
    """
    try:
        body = await request.json()

        # DEBUG: Log what we received
        logger.info(f"Apple webhook received: body_keys={list(body.keys())}, body_type={type(body)}")

        signed_payload = body.get("signedPayload")

        if not signed_payload:
            logger.warning(f"Apple webhook missing signedPayload. Body keys: {list(body.keys())}, Body: {json.dumps(body)[:500]}")
            raise HTTPException(status_code=400, detail="Missing signedPayload")

        logger.info(f"Webhook signedPayload: length={len(signed_payload)}, first_50_chars={signed_payload[:50]}")

        # Verify and decode the notification
        notification = verify_and_decode_jws(signed_payload)

    except ValueError as e:
        logger.error(f"Apple webhook signature verification failed: {e}")
        raise HTTPException(status_code=400, detail="Invalid notification signature")
    except Exception as e:
        logger.error(f"Apple webhook parse error: {e}")
        raise HTTPException(status_code=400, detail="Invalid notification format")

    notification_type = notification.get("notificationType")
    subtype = notification.get("subtype")

    logger.info(f"Received Apple webhook: {notification_type} (subtype: {subtype})")

    # Extract the signed transaction info from the notification
    data = notification.get("data", {})
    signed_transaction_info = data.get("signedTransactionInfo")

    if not signed_transaction_info:
        logger.warning(f"Apple webhook {notification_type} missing signedTransactionInfo")
        return {"status": "success", "message": "No transaction info to process"}

    # Decode the transaction info
    try:
        transaction_info = verify_and_decode_jws(signed_transaction_info)
    except ValueError as e:
        logger.error(f"Failed to decode signedTransactionInfo: {e}")
        raise HTTPException(status_code=400, detail="Invalid transaction info")

    original_transaction_id = transaction_info.get("originalTransactionId")

    if not original_transaction_id:
        logger.error("Apple webhook transaction missing originalTransactionId")
        return {"status": "error", "detail": "Missing originalTransactionId"}

    # Events that should trigger a sync
    SYNC_EVENTS = {
        "SUBSCRIBED",
        "DID_RENEW",
        "DID_CHANGE_RENEWAL_STATUS",
        "DID_CHANGE_RENEWAL_PREF",
        "EXPIRED",
        "GRACE_PERIOD_EXPIRED",
        "REVOKE",
        "REFUND",
        "DID_FAIL_TO_RENEW",
    }

    if notification_type in SYNC_EVENTS:
        result = await sync_user_from_apple(original_transaction_id, transaction_info)
        return result

    logger.info(f"Ignoring Apple notification: {notification_type}")
    return {"status": "success"}


@apple_payments_router.post(
    "/apple/restore-purchases",
    summary="Restore Apple Purchases"
)
async def restore_apple_purchases(
    request: VerifyTransactionRequest,
    current_user: AuthUser
):
    """
    Restore a user's Apple subscription after reinstall or device change.

    Called when user taps "Restore Purchases" in the app. Works similarly
    to verify-transaction but specifically for restoration flow.

    The iOS app should:
    1. Call Transaction.currentEntitlements
    2. Find the active subscription transaction
    3. Send its signedTransactionInfo here
    """
    # Verify and decode the signed transaction
    try:
        transaction = verify_and_decode_jws(request.signed_transaction)
    except ValueError as e:
        logger.error(f"Apple restore verification failed for user {current_user.id}: {e}")
        raise HTTPException(status_code=400, detail="Invalid transaction signature")

    original_transaction_id = transaction.get("originalTransactionId")
    product_id = transaction.get("productId")
    expires_date_ms = transaction.get("expiresDate")
    revocation_date = transaction.get("revocationDate")

    logger.info(f"Apple restore-purchases: user={current_user.id}, email={current_user.email}, "
                f"originalTransactionId={original_transaction_id}, productId={product_id}")

    # Check if subscription is still valid
    if revocation_date:
        raise HTTPException(status_code=400, detail="This subscription has been revoked")

    if expires_date_ms:
        expires_at = expires_date_ms / 1000
        if expires_at < time.time():
            raise HTTPException(status_code=400, detail="This subscription has expired")

    # Check if this transaction belongs to another user
    existing_user_id = await find_user_by_apple_transaction_id(original_transaction_id)
    if existing_user_id and existing_user_id != current_user.id:
        logger.warning(f"User {current_user.id} tried to restore subscription belonging to {existing_user_id}")
        raise HTTPException(
            status_code=400,
            detail="This subscription is linked to a different account"
        )

    # Check if user already has a Stripe subscription (source of truth, not stale JWT)
    has_sub, existing_id, provider, _ = await has_active_subscription(current_user.email)
    duplicate_warning = None
    if has_sub and provider == "stripe":
        logger.warning(f"User {current_user.id} restoring Apple subscription while having active Stripe subscription: {existing_id}")
        duplicate_warning = "You also have an active Stripe subscription. Please cancel one to avoid double-billing."

    # Determine tier
    is_pro, is_max, is_plus = get_tier_from_apple_product(product_id)

    if not (is_pro or is_max or is_plus):
        raise HTTPException(status_code=400, detail="Unknown subscription product")

    tier_name = "Max" if is_max else ("Pro" if is_pro else "Plus")

    logger.info(f"Restoring {tier_name} subscription for user {current_user.id} (transaction: {original_transaction_id})")

    # Update Auth0
    success = await update_user_subscription_status(
        user_id=current_user.id,
        is_pro=is_pro,
        is_max=is_max,
        is_plus=is_plus,
        apple_original_transaction_id=original_transaction_id
    )

    if not success:
        raise HTTPException(status_code=500, detail="Failed to restore subscription")

    response = {
        "status": "success",
        "tier": tier_name,
        "original_transaction_id": original_transaction_id,
        "message": "Subscription restored. Please refresh your session."
    }
    if duplicate_warning:
        response["warning"] = duplicate_warning
    return response


@apple_payments_router.get(
    "/apple/subscription-status",
    summary="Check Apple Subscription Status"
)
async def get_apple_subscription_status(current_user: AuthUser):
    """
    Get the current user's Apple subscription status from their Auth0 metadata.

    This is a quick check that doesn't query Apple - it returns the cached
    state in Auth0. For a fresh sync, the iOS app should send a new transaction.
    """
    app_metadata = current_user.app_metadata if hasattr(current_user, 'app_metadata') else {}
    has_sub, sub_id, provider = check_existing_subscription(app_metadata)

    if provider != "apple":
        return {
            "has_apple_subscription": False,
            "provider": provider,
            "message": "No Apple subscription found" if not provider else f"Subscription is via {provider}"
        }

    meta = app_metadata
    return {
        "has_apple_subscription": True,
        "original_transaction_id": sub_id,
        "is_pro": meta.get("is_pro", False),
        "is_max": meta.get("is_max", False),
        "is_plus": meta.get("is_plus", False)
    }


logger.info("Apple payments router initialized successfully.")
