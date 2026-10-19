# admin_auth.py
import os
import hmac
from fastapi import Request, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader

# --- Configuration ---
# Get your secret key from an environment variable
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY")

# Define the header we expect to find the key in
api_key_header = APIKeyHeader(name="X-Admin-Key", auto_error=False)

async def get_admin_access(key: str = Security(api_key_header)):
    """
    Dependency that checks for a valid admin API key in the X-Admin-Key header.
    """
    if not ADMIN_API_KEY:
        # This is a server configuration error, not a client error.
        raise HTTPException(
            status_code=500, detail="Admin API key is not configured on the server."
        )
    
    if key and hmac.compare_digest(key, ADMIN_API_KEY):
        # If the key is present and correct, allow access.
        return True
    else:
        # Otherwise, deny access.
        raise HTTPException(
            status_code=403, detail="You are not authorized to access this resource."
        )
