# http_client.py
"""
The process-wide httpx.AsyncClient: one connection pool per uvicorn worker,
opened and closed by the FastAPI lifespan (via api_handlers).

Lives here rather than in api_handlers so that code outside the LLM handlers
(auth0_manager) can share the pool without importing, and thereby
instantiating, every handler.
"""

import logging
from typing import Optional

import httpx

logger = logging.getLogger("http_client")

_client: Optional[httpx.AsyncClient] = None


def get_http_client() -> httpx.AsyncClient:
    """Return the shared HTTP client. Requires startup() to have run."""
    if _client is None:
        raise RuntimeError("Shared HTTP client not initialized.")
    return _client


async def startup() -> None:
    global _client
    _client = httpx.AsyncClient(
        timeout=120.0,
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    )
    logger.info("Shared HTTP client initialized")


async def shutdown() -> None:
    global _client
    if _client:
        await _client.aclose()
        _client = None
        logger.info("Shared HTTP client closed")
