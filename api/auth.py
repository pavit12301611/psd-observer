# auth.py

import os
from fastapi import Request, HTTPException, status, Depends
from jose import jwt
from jwt import PyJWKClient, PyJWTError
import logging
from typing import Annotated, Optional, Dict, Any
from pydantic import BaseModel 

# Setup logger for this module
logger = logging.getLogger('auth_validator')

# --- Configuration ---
AUTH0_DOMAIN = "auth.observer-ai.com"
API_AUDIENCE = os.environ.get("API_AUDIENCE", "https://api.observer-ai.com")
ALGORITHMS = ["RS256"]
ISSUER = f"https://{AUTH0_DOMAIN}/"
# Define the custom claim namespace from your Auth0 Action
CUSTOM_CLAIM_NAMESPACE = f"https://{os.environ.get('APP_DOMAIN', 'observer-ai.com')}/"


# --- JWKS Client ---
jwks_url = f"https://{AUTH0_DOMAIN}/.well-known/jwks.json"
jwks_client = PyJWKClient(jwks_url, cache_jwk_set=True, lifespan=3600)

# --- Pydantic Model for User Data ---
# This creates a structured object to hold user info from the token.
class AuthenticatedUser(BaseModel):
    id: str
    email: Optional[str] = None
    is_pro: bool = False # Default to False for safety
    is_max: bool = False # Max tier subscription
    is_plus: bool = False # Plus tier subscription (unlimited alerts, limited chat)
    org_id: Optional[str] = None # Enterprise org, if this user holds a seat
    app_metadata: Optional[Dict[str, Any]] = None

# --- The Updated FastAPI Dependency ---
async def get_current_user(request: Request) -> AuthenticatedUser:
    """
    A FastAPI dependency that validates the Authorization token,
    and returns an AuthenticatedUser object with the user's ID and pro status.
    Raises HTTPException if validation fails.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        logger.warning("Authorization header is missing or does not start with Bearer")
        raise credentials_exception

    token = auth_header.split(" ")[1]

    try:
        signing_key = jwks_client.get_signing_key_from_jwt(token)

        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=ALGORITHMS,
            audience=API_AUDIENCE,
            issuer=ISSUER,
            options={"verify_exp": True}
        )
        
        user_id = payload.get("sub")
        if user_id is None:
            logger.warning("Token is valid but 'sub' (user ID) is missing.")
            raise credentials_exception

        # 1. Define the claim name for the whole metadata object
        app_metadata_claim = f"{CUSTOM_CLAIM_NAMESPACE}app_metadata"
        
        # 2. Get the metadata dictionary from the token (it will be None if not present)
        app_metadata = payload.get(app_metadata_claim) or {} # Use empty dict as fallback

        # 3. Get the specific values from the metadata dictionary
        is_pro_status = app_metadata.get("is_pro", False)
        is_max_status = app_metadata.get("is_max", False)
        is_plus_status = app_metadata.get("is_plus", False)

        # 4. Get email from namespaced claim (set by Auth0 Action)
        email_claim = f"{CUSTOM_CLAIM_NAMESPACE}email"
        user_email = payload.get(email_claim)

        logger.info(f"User is pro: {is_pro_status}, is max: {is_max_status}, is plus: {is_plus_status}")

        # Return the structured user data
        return AuthenticatedUser(
            id=user_id,
            email=user_email,
            is_pro=is_pro_status,
            is_max=is_max_status,
            is_plus=is_plus_status,
            org_id=app_metadata.get("org_id"),
            app_metadata=app_metadata
        )

    except PyJWTError as e:
        logger.warning(f"JWT Validation Failed: {e}")
        raise credentials_exception
    except Exception as e:
        logger.error(f"An unexpected error occurred during auth: {e}", exc_info=True)
        raise credentials_exception

# --- UPDATED: The new type hint for dependency injection ---
AuthUser = Annotated[AuthenticatedUser, Depends(get_current_user)]

async def verify_token_from_string(token: str) -> Optional[AuthenticatedUser]:
    """
    Verify a JWT token string directly (for WebSocket auth).
    Returns AuthenticatedUser or None if invalid.
    """
    try:
        signing_key = jwks_client.get_signing_key_from_jwt(token)

        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=ALGORITHMS,
            audience=API_AUDIENCE,
            issuer=ISSUER,
            options={"verify_exp": True}
        )

        user_id = payload.get("sub")
        if user_id is None:
            return None

        app_metadata_claim = f"{CUSTOM_CLAIM_NAMESPACE}app_metadata"
        app_metadata = payload.get(app_metadata_claim) or {}

        email_claim = f"{CUSTOM_CLAIM_NAMESPACE}email"

        return AuthenticatedUser(
            id=user_id,
            email=payload.get(email_claim),
            is_pro=app_metadata.get("is_pro", False),
            is_max=app_metadata.get("is_max", False),
            is_plus=app_metadata.get("is_plus", False),
            org_id=app_metadata.get("org_id"),
            app_metadata=app_metadata
        )

    except (PyJWTError, Exception) as e:
        logger.warning(f"WebSocket token validation failed: {e}")
        return None
