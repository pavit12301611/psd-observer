# r2_store.py
"""
Cloudflare R2 object store for enterprise org records.

Object types, all written by direct key — nothing here ever lists:

    orgs/{org_id}.json      the org record, members inline
    invites/{token}.json    a pending seat invite, single use
    temp/{uuid}.{ext}       outbound message media, served back by the API

R2 is not on the request hot path. Auth, quota and model routing all run off
the JWT (which carries `org_id` and `is_pro`), so these objects are read only
during team-page and admin operations.

boto3 is synchronous, so every call is pushed to a worker thread to keep the
event loop free.
"""

import asyncio
import json
import logging
import os
from typing import Any, Callable, Optional, Tuple

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

logger = logging.getLogger('r2_store')

R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY")
R2_BUCKET = os.environ.get("R2_BUCKET", "observer-orgs")

_client = None


class PreconditionFailed(Exception):
    """The object changed between our read and our write (ETag mismatch)."""


def _get_client():
    global _client
    if _client is not None:
        return _client

    if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY]):
        raise RuntimeError("R2 credentials are not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)")

    _client = boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
        config=Config(retries={"max_attempts": 3, "mode": "standard"}),
    )
    return _client


def _get_json_sync(key: str) -> Tuple[Optional[dict], Optional[str]]:
    try:
        resp = _get_client().get_object(Bucket=R2_BUCKET, Key=key)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None, None
        raise
    body = resp["Body"].read()
    etag = resp.get("ETag")
    return json.loads(body), etag


def _put_json_sync(key: str, data: dict, if_match: Optional[str], if_none_match: Optional[str]) -> str:
    params = {
        "Bucket": R2_BUCKET,
        "Key": key,
        "Body": json.dumps(data, ensure_ascii=False).encode("utf-8"),
        "ContentType": "application/json",
    }
    if if_match:
        params["IfMatch"] = if_match
    if if_none_match:
        params["IfNoneMatch"] = if_none_match

    try:
        resp = _get_client().put_object(**params)
    except ClientError as e:
        code = e.response["Error"]["Code"]
        status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in ("PreconditionFailed", "ConditionalRequestConflict") or status in (409, 412):
            raise PreconditionFailed(key) from e
        raise
    return resp.get("ETag")


def _put_bytes_sync(key: str, body: bytes, content_type: str, content_encoding: Optional[str]) -> str:
    params = {
        "Bucket": R2_BUCKET,
        "Key": key,
        "Body": body,
        "ContentType": content_type,
    }
    if content_encoding:
        params["ContentEncoding"] = content_encoding
    resp = _get_client().put_object(**params)
    return resp.get("ETag")


def _get_bytes_sync(key: str) -> Optional[Tuple[bytes, str]]:
    try:
        resp = _get_client().get_object(Bucket=R2_BUCKET, Key=key)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None
        raise
    return resp["Body"].read(), resp.get("ContentType", "application/octet-stream")


def _delete_sync(key: str) -> None:
    _get_client().delete_object(Bucket=R2_BUCKET, Key=key)


async def get_json(key: str) -> Tuple[Optional[dict], Optional[str]]:
    """Returns (data, etag). (None, None) if the object does not exist."""
    return await asyncio.to_thread(_get_json_sync, key)


async def put_json(
    key: str,
    data: dict,
    if_match: Optional[str] = None,
    if_none_match: Optional[str] = None,
) -> str:
    """
    Write a JSON object. Pass if_match=<etag> for an optimistic-concurrency
    write, or if_none_match="*" to fail if the key already exists.

    Raises PreconditionFailed when the condition is not met.
    """
    return await asyncio.to_thread(_put_json_sync, key, data, if_match, if_none_match)


async def put_bytes(
    key: str,
    body: bytes,
    content_type: str = "application/octet-stream",
    content_encoding: Optional[str] = None,
) -> str:
    """
    Write raw bytes. Unconditional: callers that use this write to keys nobody
    else writes, so there is no race to guard against.
    """
    return await asyncio.to_thread(_put_bytes_sync, key, body, content_type, content_encoding)


async def get_bytes(key: str) -> Optional[Tuple[bytes, str]]:
    """Returns (body, content_type), or None if the object does not exist."""
    return await asyncio.to_thread(_get_bytes_sync, key)


async def delete(key: str) -> None:
    await asyncio.to_thread(_delete_sync, key)


async def update_json(key: str, mutator: Callable[[dict], Any], retries: int = 5) -> dict:
    """
    Read-modify-write a JSON object under an ETag precondition.

    `mutator` receives the current record and mutates it in place. It is called
    again on each retry with freshly read data, so any guard it enforces (seat
    limits, duplicate members) is re-checked against the winning version rather
    than the stale one we lost the race to.

    Raises FileNotFoundError if the key does not exist, PreconditionFailed if
    every attempt lost the race.
    """
    for attempt in range(retries):
        record, etag = await get_json(key)
        if record is None:
            raise FileNotFoundError(key)

        mutator(record)

        try:
            await put_json(key, record, if_match=etag)
            return record
        except PreconditionFailed:
            if attempt == retries - 1:
                raise
            logger.warning(f"Lost write race on {key}, retrying ({attempt + 1}/{retries})")
            await asyncio.sleep(0.1 * (attempt + 1))

    raise PreconditionFailed(key)


def org_key(org_id: str) -> str:
    return f"orgs/{org_id}.json"


def invite_key(token: str) -> str:
    return f"invites/{token}.json"


def marketplace_key() -> str:
    """
    The whole agent catalog in one object. Small (tens of KB), read constantly
    and written only on publish or delete, so one object under an ETag
    precondition is cheaper and simpler than a key per agent - a listing would
    otherwise be N GETs.
    """
    return "marketplace/agents.json"


def temp_media_key(filename: str) -> str:
    """
    Media handed to a messaging provider as a URL. Written by whichever box
    handled the send and read back by whichever box the provider's fetch is
    routed to, which is why it cannot live on a box's disk.

    Expiry is a bucket lifecycle rule on this prefix, not something the API
    does: nothing here knows when a provider has finished fetching.
    """
    return f"temp/{filename}"

