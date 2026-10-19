# auth0_manager.py

import asyncio
import os
import logging
import time
from urllib.parse import quote

import httpx

from http_client import get_http_client

logger = logging.getLogger(__name__)

# --- Configuration from Environment Variables ---
AUTH0_DOMAIN = os.environ.get("AUTH0_DOMAIN")
MGMT_API_CLIENT_ID = os.environ.get("AUTH0_MGMT_CLIENT_ID")
MGMT_API_CLIENT_SECRET = os.environ.get("AUTH0_MGMT_CLIENT_SECRET")
# The audience for the Management API is always the API v2 endpoint
MGMT_API_AUDIENCE = f"https://{AUTH0_DOMAIN}/api/v2/"

# Every Management API call is async on the shared httpx pool. These used to be
# synchronous `requests` calls inside async functions, which stalled the whole
# worker's event loop for each Auth0 round trip, with no timeout at all.
AUTH0_TIMEOUT = 10.0
# Blocking calls also serialized Auth0 traffic per worker for free. Async ones
# don't, and /admin/usage?emails=true gathers one lookup per active user, so cap
# in-flight requests explicitly to stay clear of Auth0's Management API rate limit.
_MGMT_SLOTS = asyncio.Semaphore(4)
# Refresh the cached token this long before Auth0 says it expires.
TOKEN_EXPIRY_MARGIN = 300

# --- In-memory caches ---
_email_cache = {}  # user_id -> email (unbounded, no expiration)
_mgmt_token = None  # cached management API token
_token_expires_at = 0  # epoch timestamp when token expires
# One token fetch at a time: without it, every request that arrives while the
# token is expired would fetch its own.
_token_lock = asyncio.Lock()

async def _get_management_api_token() -> str:
    """
    Fetches a fresh access token for the Auth0 Management API.
    Cached in memory until shortly before the expiry Auth0 reports.
    """
    global _mgmt_token, _token_expires_at

    # Check if cached token is still valid
    if _mgmt_token and time.time() < _token_expires_at:
        return _mgmt_token

    async with _token_lock:
        # Another request may have refreshed it while we waited for the lock.
        if _mgmt_token and time.time() < _token_expires_at:
            return _mgmt_token

        if not all([AUTH0_DOMAIN, MGMT_API_CLIENT_ID, MGMT_API_CLIENT_SECRET]):
            logger.error("Auth0 Management API credentials are not fully configured.")
            raise ValueError("Auth0 Management API credentials are not set in environment.")

        payload = {
            "client_id": MGMT_API_CLIENT_ID,
            "client_secret": MGMT_API_CLIENT_SECRET,
            "audience": MGMT_API_AUDIENCE,
            "grant_type": "client_credentials"
        }

        try:
            response = await get_http_client().post(
                f"https://{AUTH0_DOMAIN}/oauth/token", json=payload, timeout=AUTH0_TIMEOUT
            )
            response.raise_for_status() # Raise an exception for HTTP errors (4xx or 5xx)

            body = response.json()
            _mgmt_token = body["access_token"]
            # Auth0 reports the lifetime (24h by default). Fall back to the old
            # fixed 4 hours if it ever doesn't.
            lifetime = body.get("expires_in", 4 * 60 * 60)
            _token_expires_at = time.time() + max(lifetime - TOKEN_EXPIRY_MARGIN, 60)

            logger.info("Successfully fetched Auth0 Management API token.")
            return _mgmt_token
        except httpx.HTTPError as e:
            logger.error(f"Failed to get Auth0 Management API token: {e}")
            raise


async def _mgmt_request(method: str, path: str, **kwargs) -> httpx.Response:
    """
    One authenticated Management API call. `path` is relative to /api/v2/.
    Raises httpx.HTTPStatusError on a 4xx/5xx, like raise_for_status() did.
    """
    token = await _get_management_api_token()
    async with _MGMT_SLOTS:
        response = await get_http_client().request(
            method,
            f"{MGMT_API_AUDIENCE}{path}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=AUTH0_TIMEOUT,
            **kwargs,
        )
    response.raise_for_status()
    return response


def _user_path(user_id: str) -> str:
    # Auth0 ids contain "|" (e.g. "google-oauth2|1184..."). requests percent-
    # encoded it on its own; httpx leaves it raw, so quote explicitly.
    return f"users/{quote(user_id, safe='')}"

# Sentinel value to indicate a field should be cleared (deleted) from metadata
CLEAR_FIELD = "__CLEAR__"


async def update_user_subscription_status(
    user_id: str,
    is_pro: bool = None,
    is_max: bool = None,
    is_plus: bool = None,
    stripe_customer_id: str = None,
    stripe_subscription_id: str = None,
    apple_original_transaction_id: str = None,
    org_id: str = None,
    org_tier: str = None
) -> bool:
    """
    Updates a user's app_metadata in Auth0 to set their subscription status
    and link their payment provider IDs (Stripe or Apple).

    To CLEAR a field (remove it from metadata), pass CLEAR_FIELD as the value.
    Example: stripe_subscription_id=CLEAR_FIELD will delete that field.

    Args:
        user_id: Auth0 user ID
        is_pro: Pro subscription status (optional)
        is_max: Max subscription status (optional)
        is_plus: Plus subscription status (optional)
        stripe_customer_id: Stripe customer ID (optional, CLEAR_FIELD to remove)
        stripe_subscription_id: Stripe subscription ID (optional, CLEAR_FIELD to remove)
        apple_original_transaction_id: Apple original transaction ID (optional, CLEAR_FIELD to remove)
    """
    try:
        # Build the metadata payload dynamically
        app_metadata = {}
        if is_pro is not None:
            app_metadata["is_pro"] = is_pro
        if is_max is not None:
            app_metadata["is_max"] = is_max
        if is_plus is not None:
            app_metadata["is_plus"] = is_plus

        # Handle stripe_customer_id (string value or CLEAR_FIELD to delete)
        if stripe_customer_id == CLEAR_FIELD:
            app_metadata["stripe_customer_id"] = None  # Auth0 removes field when set to null
        elif stripe_customer_id:
            app_metadata["stripe_customer_id"] = stripe_customer_id

        # Handle stripe_subscription_id (string value or CLEAR_FIELD to delete)
        if stripe_subscription_id == CLEAR_FIELD:
            app_metadata["stripe_subscription_id"] = None
        elif stripe_subscription_id:
            app_metadata["stripe_subscription_id"] = stripe_subscription_id

        # Handle apple_original_transaction_id (string value or CLEAR_FIELD to delete)
        if apple_original_transaction_id == CLEAR_FIELD:
            app_metadata["apple_original_transaction_id"] = None
        elif apple_original_transaction_id:
            app_metadata["apple_original_transaction_id"] = apple_original_transaction_id

        # Handle org_id / org_tier (the enterprise-seat sentinel)
        if org_id == CLEAR_FIELD:
            app_metadata["org_id"] = None
        elif org_id:
            app_metadata["org_id"] = org_id

        if org_tier == CLEAR_FIELD:
            app_metadata["org_tier"] = None
        elif org_tier:
            app_metadata["org_tier"] = org_tier

        payload = { "app_metadata": app_metadata }

        await _mgmt_request("PATCH", _user_path(user_id), json=payload)

        logger.info(f"Successfully updated user {user_id} subscription status: is_pro={is_pro}, is_max={is_max}, is_plus={is_plus}")
        return True
    except Exception as e:
        logger.error(f"Failed to update user {user_id} in Auth0: {e}")
        if hasattr(e, 'response') and e.response is not None:
            logger.error(f"Auth0 Response: {e.response.text}")
        return False
        
# This is a new helper function we'll need for webhooks
async def find_user_by_stripe_customer_id(stripe_customer_id: str) -> str:
    """
    Finds a user's Auth0 ID by querying their app_metadata for a Stripe Customer ID.
    """
    try:
        # This is a powerful Auth0 feature: querying users by metadata
        params = {'q': f'app_metadata.stripe_customer_id:"{stripe_customer_id}"', 'search_engine': 'v3'}

        response = await _mgmt_request("GET", "users", params=params)

        users = response.json()
        if users and len(users) > 0:
            user_id = users[0]['user_id']
            logger.info(f"Found user {user_id} for stripe_customer_id {stripe_customer_id}")
            return user_id
        else:
            logger.warning(f"Could not find a user for stripe_customer_id: {stripe_customer_id}")
            return None
    except Exception as e:
        logger.error(f"Error finding user by stripe_customer_id: {e}")
        return None

async def find_user_by_email(email: str) -> str:
    """
    Finds a user's Auth0 ID by their email address.

    Args:
        email: The user's email address

    Returns:
        Auth0 user ID if found, None otherwise
    """
    try:
        # Query users by email
        params = {'q': f'email:"{email}"', 'search_engine': 'v3'}

        response = await _mgmt_request("GET", "users", params=params)

        users = response.json()
        if users and len(users) > 0:
            user_id = users[0]['user_id']
            logger.info(f"Found user {user_id} for email {email}")
            return user_id
        else:
            logger.warning(f"Could not find a user with email: {email}")
            return None
    except Exception as e:
        logger.error(f"Error finding user by email: {e}")
        return None

async def get_email_by_id(user_id: str) -> str:
    """
    Fetches user email from Auth0 by user ID.
    Uses in-memory cache to reduce API calls.

    Args:
        user_id: Auth0 user ID

    Returns:
        User email string or None if not found
    """
    global _email_cache

    # Check cache first
    if user_id in _email_cache:
        return _email_cache[user_id]

    try:
        response = await _mgmt_request("GET", _user_path(user_id))

        user_data = response.json()
        email = user_data.get("email")

        if email:
            # Cache the email for future lookups
            _email_cache[user_id] = email
            logger.info(f"Successfully fetched email for user {user_id}")
            return email
        else:
            logger.warning(f"No email found for user {user_id}")
            return None
    except Exception as e:
        logger.error(f"Error fetching email for user {user_id}: {e}")
        return None


async def delete_user(user_id: str) -> bool:
    """
    Permanently deletes a user from Auth0.

    Args:
        user_id: Auth0 user ID

    Returns:
        True if deletion was successful, False otherwise
    """
    global _email_cache

    try:
        await _mgmt_request("DELETE", _user_path(user_id))

        # Clear from email cache if present
        if user_id in _email_cache:
            del _email_cache[user_id]

        logger.info(f"Successfully deleted user {user_id} from Auth0")
        return True
    except Exception as e:
        logger.error(f"Failed to delete user {user_id} from Auth0: {e}")
        if hasattr(e, 'response') and e.response is not None:
            logger.error(f"Auth0 Response: {e.response.text}")
        return False


async def find_user_by_apple_transaction_id(original_transaction_id: str) -> str:
    """
    Finds a user's Auth0 ID by querying their app_metadata for an Apple original transaction ID.

    Args:
        original_transaction_id: The Apple originalTransactionId

    Returns:
        Auth0 user ID if found, None otherwise
    """
    try:
        params = {
            'q': f'app_metadata.apple_original_transaction_id:"{original_transaction_id}"',
            'search_engine': 'v3'
        }

        response = await _mgmt_request("GET", "users", params=params)

        users = response.json()
        if users and len(users) > 0:
            user_id = users[0]['user_id']
            logger.info(f"Found user {user_id} for apple_original_transaction_id {original_transaction_id}")
            return user_id
        else:
            logger.warning(f"Could not find a user for apple_original_transaction_id: {original_transaction_id}")
            return None
    except Exception as e:
        logger.error(f"Error finding user by apple_original_transaction_id: {e}")
        return None


async def get_user_app_metadata(user_id: str) -> dict:
    """
    Fetches a user's app_metadata from Auth0.

    Args:
        user_id: Auth0 user ID

    Returns:
        app_metadata dict or empty dict if not found
    """
    try:
        response = await _mgmt_request("GET", _user_path(user_id))

        user_data = response.json()
        return user_data.get("app_metadata", {})
    except Exception as e:
        logger.error(f"Error fetching app_metadata for user {user_id}: {e}")
        return {}


async def check_apple_subscription_by_email(email: str) -> tuple[bool, str | None]:
    """
    Check if any Auth0 user with this email has an active Apple subscription.
    Queries Auth0 directly (not relying on JWT which could be stale).

    Args:
        email: User's email address

    Returns:
        (has_subscription, apple_original_transaction_id)
    """
    if not email:
        return False, None

    try:
        params = {'q': f'email:"{email.lower()}"', 'search_engine': 'v3'}

        response = await _mgmt_request("GET", "users", params=params)

        users = response.json()
        for user in users:
            app_metadata = user.get('app_metadata', {})
            if isinstance(app_metadata, dict):
                apple_id = app_metadata.get('apple_original_transaction_id')
                if apple_id:
                    return True, apple_id

        return False, None
    except Exception as e:
        logger.error(f"Error checking Apple subscription by email {email}: {e}")
        return False, None


def check_existing_subscription(app_metadata: dict) -> tuple[bool, str | None, str | None]:
    """
    Check if user has an existing active subscription based on app_metadata.

    The presence of stripe_subscription_id or apple_original_transaction_id
    indicates an ACTIVE subscription. These fields are cleared when subscription ends.

    Args:
        app_metadata: User's app_metadata dict (from JWT or Auth0)

    Returns:
        (has_subscription, subscription_id, provider)
        - has_subscription: True if active subscription exists
        - subscription_id: The subscription/transaction ID
        - provider: "apple" or "stripe" or None
    """
    if not app_metadata or not isinstance(app_metadata, dict):
        return False, None, None

    # Enterprise seat. Checked first because an org member is billed through the
    # org's Stripe customer, never their own, so no personal ID will be present.
    org_id = app_metadata.get('org_id')
    if org_id:
        return True, org_id, "org"

    # Check Apple first (arbitrary order, doesn't matter since user can only have one)
    apple_id = app_metadata.get('apple_original_transaction_id')
    if apple_id:
        return True, apple_id, "apple"

    # Check Stripe
    stripe_id = app_metadata.get('stripe_subscription_id')
    if stripe_id:
        return True, stripe_id, "stripe"

    return False, None, None
