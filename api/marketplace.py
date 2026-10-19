"""
Community agent marketplace, stored as one JSON catalog in R2.

The catalog is tens of KB and written only when someone publishes or deletes an
agent, so it lives as a single object rather than a key per agent: a listing is
one GET instead of N, and the rare write takes an ETag precondition to keep two
concurrent publishes from losing each other. Nothing here is box-local, which
is what lets the API run from more than one machine.

There is deliberately no download counter. Nothing renders one, and
incrementing it would make every agent fetch a read-modify-write of the whole
catalog - the one access pattern this layout is bad at.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from auth import AuthUser
import asyncio
import datetime
import logging
import time

import r2_store

logger = logging.getLogger('marketplace')

marketplace_router = APIRouter()

# Reads are far more frequent than writes and the catalog is small, so it is
# held in memory and refreshed on a timer. The window is the longest a newly
# published agent can stay invisible to a box that did not publish it; writers
# drop their own cache immediately, so the publisher always sees their own
# agent. Short enough not to be confusing, long enough that a busy listing is
# not an R2 round trip per request.
CACHE_TTL = 30.0

_cache: dict | None = None
_cached_at = 0.0
_lock = asyncio.Lock()


class Agent(BaseModel):
    id: str
    name: str
    description: Optional[str] = ""
    model_name: str
    system_prompt: Optional[str] = ""
    loop_interval_seconds: float
    code: str
    memory: Optional[str] = ""
    author: Optional[str] = None
    author_id: Optional[str] = None
    date_added: Optional[str] = None
    featured_order: Optional[int] = None


async def _load(force: bool = False) -> dict:
    """The agent catalog, keyed by id. Cached for CACHE_TTL."""
    global _cache, _cached_at

    if not force and _cache is not None and time.monotonic() - _cached_at < CACHE_TTL:
        return _cache

    async with _lock:
        # Another request may have refreshed it while we waited for the lock.
        if not force and _cache is not None and time.monotonic() - _cached_at < CACHE_TTL:
            return _cache

        catalog, _etag = await r2_store.get_json(r2_store.marketplace_key())
        _cache = (catalog or {}).get("agents", {})
        _cached_at = time.monotonic()
        return _cache


def _invalidate() -> None:
    global _cached_at
    _cached_at = 0.0


async def _update(mutator) -> None:
    """
    Read-modify-write the catalog under an ETag precondition. `mutator` gets the
    agents dict and mutates it in place; it is re-run against fresh data on each
    retry, so any check it makes is re-checked against the version that wins.
    """
    def apply(record: dict) -> None:
        mutator(record.setdefault("agents", {}))

    try:
        await r2_store.update_json(r2_store.marketplace_key(), apply)
    except FileNotFoundError:
        # First write on a fresh bucket. if_none_match makes the create itself a
        # race we can lose, in which case the retry finds the object and takes
        # the normal path.
        record = {"agents": {}}
        apply(record)
        try:
            await r2_store.put_json(
                r2_store.marketplace_key(), record, if_none_match="*"
            )
        except r2_store.PreconditionFailed:
            await r2_store.update_json(r2_store.marketplace_key(), apply)
    finally:
        _invalidate()


def _sorted(agents: dict) -> list:
    """Featured first in their curated order, then most recent."""
    # Two passes rather than one composite key: the two tiers sort in opposite
    # directions, and Python's stable sort composes them correctly for free.
    # Ties fall back to the id so the order does not wobble between requests.
    by_recency = sorted(
        agents.values(),
        key=lambda a: (a.get("date_added") or "", a.get("id") or ""),
        reverse=True,
    )
    return sorted(
        by_recency,
        key=lambda a: (a.get("featured_order") is None, a.get("featured_order") or 0),
    )


@marketplace_router.get("/marketplace-status")
async def marketplace_root():
    return {"status": "Marketplace service is running"}


@marketplace_router.get("/agents")
async def list_agents():
    return _sorted(await _load())


# Declared before /agents/{agent_id}: FastAPI matches routes in declaration
# order, so with the parameterised route first this one was unreachable and
# every call 404'd as a missing agent named "statistics".
@marketplace_router.get("/agents/statistics")
async def get_agent_statistics():
    agents = await _load()

    models: dict[str, int] = {}
    for agent in agents.values():
        name = agent.get("model_name")
        if name:
            models[name] = models.get(name, 0) + 1
    popular = sorted(models.items(), key=lambda kv: (-kv[1], kv[0]))[:5]

    return {
        "total_agents": len(agents),
        "unique_authors": len({a["author_id"] for a in agents.values() if a.get("author_id")}),
        "popular_models": [{"model_name": m, "count": c} for m, c in popular],
    }


@marketplace_router.get("/agents/by-author/{author_id}")
async def get_agents_by_author(author_id: str):
    agents = await _load()
    return [a for a in agents.values() if a.get("author_id") == author_id]


@marketplace_router.get("/agents/{agent_id}")
async def get_agent(agent_id: str):
    agents = await _load()
    agent = agents.get(agent_id)
    if not agent:
        # A miss may just be a stale cache: an agent published seconds ago on
        # another box is not in ours yet. Confirm against R2 before 404ing.
        agent = (await _load(force=True)).get(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@marketplace_router.post("/agents")
async def create_agent(agent: Agent, user: AuthUser):
    if not agent.date_added:
        agent.date_added = datetime.datetime.now().isoformat()
    agent.author_id = user.id
    agent.featured_order = None

    record = agent.model_dump()
    assigned: dict = {}

    def mutator(agents: dict) -> None:
        # Re-run on every retry, so the id is checked against the catalog that
        # actually wins rather than the one we first read.
        candidate, counter = agent.id, 2
        while candidate in agents:
            candidate = f"{agent.id}_{counter}"
            counter += 1
        record["id"] = candidate
        assigned["id"] = candidate
        agents[candidate] = dict(record)

    await _update(mutator)
    logger.info(f"Published agent {assigned['id']} by {user.id}")
    return {"success": True, "id": assigned["id"]}


@marketplace_router.delete("/agents/{agent_id}")
async def delete_agent(agent_id: str, user: AuthUser):
    # Checked up front so the common failures answer without a write attempt.
    # The mutator re-checks both, since it runs against freshly read data.
    agents = await _load(force=True)
    agent = agents.get(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if agent.get("author_id") != user.id:
        raise HTTPException(status_code=403, detail="You can only delete your own agents")

    def mutator(agents: dict) -> None:
        current = agents.get(agent_id)
        if current is None:
            return
        if current.get("author_id") != user.id:
            raise HTTPException(status_code=403, detail="You can only delete your own agents")
        del agents[agent_id]

    await _update(mutator)
    logger.info(f"Deleted agent {agent_id} for {user.id}")
    return {"success": True}


async def delete_agents_by_author(author_id: str) -> int:
    """Account deletion. Returns how many agents were removed."""
    removed = 0

    def mutator(agents: dict) -> None:
        nonlocal removed
        # Reset per attempt: the mutator re-runs on a lost race and would
        # otherwise accumulate counts across attempts.
        removed = 0
        for agent_id in [i for i, a in agents.items() if a.get("author_id") == author_id]:
            del agents[agent_id]
            removed += 1

    await _update(mutator)
    return removed
