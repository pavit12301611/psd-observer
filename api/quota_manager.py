import datetime
import logging
import math
import os
import asyncio
import httpx
from typing import Dict

import r2_store
from redis_client import get_redis

logger = logging.getLogger('quota_manager')

# --- Configuration ---
QUOTA_LIMITS = {
    "monitor": 60,       # 30 min/day at 30s loops
    "agent_creator": 45,   # 3 agent sessions × ~15 msgs
    "sms": 5,
    "whatsapp": 5,
    "email": 2880,
    "pushover": 5,
    "discord": 5,
    "telegram": 2880,
    "slack": 5,
    "teams": 5,
    "voice_call": 5,
}

# Plus user limits (unlimited alerts, limited chat)
PLUS_QUOTA_LIMITS = {
    "monitor": 60,
    "agent_creator": 1000,  # plus legacy tier
    "sms": 100,
    "whatsapp": 100,
    "email": 2880,
    "pushover": 2880,
    "discord": 2880,
    "telegram": 2880,
    "slack": 100,
    "teams": 100,
    "voice_call": 100,
}

# Pro user limits (anti-abuse measure)
# sms/whatsapp/voice_call are 300/day - a burst ceiling only. The real budget
# control for these three is the shared monthly NOTIFICATION_MONTHLY_LIMITS
# pool below; 300/day just stops one day from becoming a denial-of-wallet
# attack on its own before the monthly check even applies.
PRO_QUOTA_LIMITS = {
    "monitor": 1440,     # 12h/day at 30s loops
    "agent_creator": 1000,
    "sms": 300,
    "whatsapp": 300,
    "email": 2880,
    "pushover": 2880,
    "discord": 2880,
    "telegram": 2880,
    "slack": 2880,
    "teams": 2880,
    "voice_call": 300,
}

# Max user limits (highest tier)
MAX_QUOTA_LIMITS = {
    "monitor": 2880, # 30s interval for 24h = 2/minx60x24=2880
    "agent_creator": 1000,
    "sms": 300,
    "whatsapp": 300,
    "email": 2880,
    "pushover": 2880,
    "discord": 2880,
    "telegram": 2880,
    "slack": 2880,
    "teams": 2880,
    "voice_call": 300,
}

# --- Monthly credit caps ----------------------------------------------------
#
# The daily tables above bound the *rate*; these bound the *budget*. Both are
# enforced, and that pairing is deliberate: the daily cap is what makes a
# monthly cap safe to ship. A runaway agent costs a user one day rather than
# their whole month, and a subscriber who signs up on the 28th cannot
# front-load a month's credits into the three days before the calendar rolls.
#
# NO_MONTHLY_LIMIT means the monthly key is never read or written, so an
# unmetered service costs nothing extra on the hot path.
NO_MONTHLY_LIMIT = -1

# A monthly-metered service draws down a named "meter". monitor meters
# against itself; sms/whatsapp/voice_call all draw from one shared
# "notifications" meter (see NOTIFICATION_MONTHLY_LIMITS below) because their
# real cost only makes sense budgeted in dollars, pooled - a user should be
# able to burst the whole month's budget into whichever channel they
# actually use rather than being boxed into a fixed per-channel slice.
# Anything not listed here is daily-only.
MONTHLY_METER_GROUP = {
    "monitor": "monitor",
    "agent_creator": "agent_creator",
    "sms": "notifications",
    "whatsapp": "notifications",
    "voice_call": "notifications",
}

# agent_creator is ~15 calls per session, so 150/1500/3000 is ~10/100/200
# sessions; worst-case gemini-flash-lite spend is ~$0.15 / $1.50 / $3.00.
FREE_MONTHLY_LIMITS = {"monitor": 1_200, "agent_creator": 150}     # 10 hours at 30s loops (2 calls/min)
PRO_MONTHLY_LIMITS  = {"monitor": 12_000, "agent_creator": 1_500}  # 100 hours at 30s loops (2 calls/min)

# Max is capped by its daily limit alone: 2880/day cannot reach any monthly
# number worth writing down, so a cap here would be config that never applies.
# agent_creator is the exception: 1000/day would reach ~$30/month of Gemini.
MAX_MONTHLY_LIMITS  = {"monitor": NO_MONTHLY_LIMIT, "agent_creator": 3_000}

# Plus is a closed legacy tier. It is left uncapped rather than quietly given
# terms nobody agreed to; its 60/day ceiling already bounds the damage.
PLUS_MONTHLY_LIMITS = {"monitor": NO_MONTHLY_LIMIT}

# --- Notification budget (SMS / WhatsApp / voice) ---------------------------
#
# The daily QUOTA_LIMITS tables above bound the burst *rate* per channel;
# this bounds actual Twilio dollar *exposure* per user per month - the number
# that actually protects the bill. A daily-only cap doesn't: it just lets
# someone hit the ceiling every day for a month instead of in one day (e.g.
# 100/day x 30 = 3,000 SMS/month, ~$36, against a $20 Pro subscription).
#
# Denominated in "notification credits" = $0.0001, so each channel's real
# per-send cost converts to a whole-number weight and the atomic consume
# script can INCRBY it exactly like a plain counter - no floats on the hot
# path. Costs are effective USD costs incl. carrier/template fees, priced
# 2026-09; see the notification-budget financial calc for sourcing.
NOTIFICATION_CREDIT_VALUE = 0.0001  # USD per credit

SMS_CREDITS = 120               # ~$0.0120 / message (Twilio + carrier pass-through)
WHATSAPP_CREDITS = 100          # ~$0.0100 / message (incl. Meta template fee estimate)
VOICE_CREDITS_PER_MINUTE = 130  # ~$0.0130 / minute - Twilio bills full minutes, rounded up

# Twilio bills a 1-minute minimum per call even though average talk time is
# ~20s, so a plain per-call charge already covers that. This only matters for
# unusually long TTS messages (up to 4096 chars, ~5 min of speech) so those
# aren't undercharged at the 1-minute floor.
VOICE_CHARS_PER_MINUTE = 800

FREE_NOTIFICATION_BUDGET = 5_000     # $0.50/month
PRO_NOTIFICATION_BUDGET  = 70_000    # $7.00/month
MAX_NOTIFICATION_BUDGET  = 70_000    # $7.00/month
# Plus is a closed legacy tier - left uncapped, same reasoning as PLUS_MONTHLY_LIMITS.
PLUS_NOTIFICATION_BUDGET = NO_MONTHLY_LIMIT

NOTIFICATION_MONTHLY_LIMITS = {
    "free": FREE_NOTIFICATION_BUDGET,
    "plus": PLUS_NOTIFICATION_BUDGET,
    "pro": PRO_NOTIFICATION_BUDGET,
    "max": MAX_NOTIFICATION_BUDGET,
}

# Monthly counters carry their period in the key name, so the reset is a key
# rotation rather than a TTL expiry and a lost EXPIRE can never strand a user
# at their cap. The TTL is therefore garbage collection only, and just has to
# outlive the longest month by a comfortable margin.
MONTHLY_KEY_TTL = 35 * 86400

# How long a Redis-cached org pool size is trusted. Only a safety net: admin
# edits call invalidate_org_limit() and take effect on the next request.
ORG_LIMIT_CACHE_TTL = 3600


# Rate limiting configuration (requests per minute)
RATE_LIMIT_PER_MINUTE = 30

# Audio second limits per provider per tier
CHIRP_SECOND_LIMITS = {
    "free":   2_700,   # 45 min
    "plus":   2_700,   # 45 min
    "pro":   10_800,   # 3 hours
    "max":   10_800,   # 3 hours
}
# Monthly Deepgram (chirp3 bucket) audio budget, ~$0.0058/min: ~$0.35 / $1.74 /
# $10.44 worst case. Plus is a closed legacy tier, left uncapped like
# PLUS_MONTHLY_LIMITS; its 45 min/day ceiling already bounds it.
CHIRP_MONTHLY_SECOND_LIMITS = {
    "free":    3_600,   # 1 hour
    "plus":    NO_MONTHLY_LIMIT,
    "pro":    18_000,   # 5 hours
    "max":   108_000,   # 30 hours
}

def _seconds_until_midnight() -> int:
    """
    Seconds until the next UTC midnight.

    Explicitly UTC so daily quota resets do not depend on the container's
    ambient timezone - they line up with the UTC day keys used by
    creator-log days, and setting TZ on the container cannot silently shift
    every user's reset.
    """
    now = datetime.datetime.now(datetime.timezone.utc)
    midnight = datetime.datetime.combine(
        now.date() + datetime.timedelta(days=1),
        datetime.time.min,
        tzinfo=datetime.timezone.utc,
    )
    return int((midnight - now).total_seconds())

def _next_month_start() -> datetime.datetime:
    """First instant of the next UTC calendar month."""
    now = datetime.datetime.now(datetime.timezone.utc)
    year, month = (now.year + 1, 1) if now.month == 12 else (now.year, now.month + 1)
    return datetime.datetime(year, month, 1, tzinfo=datetime.timezone.utc)


def _next_midnight() -> datetime.datetime:
    now = datetime.datetime.now(datetime.timezone.utc)
    return datetime.datetime.combine(
        now.date() + datetime.timedelta(days=1),
        datetime.time.min,
        tzinfo=datetime.timezone.utc,
    )


def current_month() -> str:
    """The period stamp embedded in monthly keys. UTC calendar month.

    Calendar months rather than per-subscriber billing cycles: a billing-aligned
    period needs a boundary stored per user, which does not exist for individual
    subscribers today. The period is a string in the key, so if that changes the
    only thing that moves is this function.
    """
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m")


def daily_key(user_id: str, service: str) -> str:
    return f"quota:{user_id}:{service}"


def monthly_key(user_id: str | None, service: str, org_id: str | None = None) -> str:
    """
    Enterprise seats count against one shared org key; everyone else against
    their own. Both prefixes deliberately sit outside "quota:" - get_usage()
    scans quota:* and splits on ":" expecting exactly three parts.
    """
    if org_id:
        return f"orgquota:{org_id}:{service}:{current_month()}"
    return f"mquota:{user_id}:{service}:{current_month()}"


def org_limit_key(org_id: str) -> str:
    return f"orglimit:{org_id}"


async def _send_abuse_alert_async(user_id: str, service: str):
    try:
        telegram_bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
        if not telegram_bot_token:
            logger.warning("Cannot send abuse alert: TELEGRAM_BOT_TOKEN not configured")
            return

        admin_chat_id = os.getenv("ADMIN_TELEGRAM_CHAT_ID")
        message = f"⚠️ Rate limit exceeded!\n\nUser ID: {user_id}\nService: {service}\nTime: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        url = f"https://api.telegram.org/bot{telegram_bot_token}/sendMessage"

        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(url, json={"chat_id": admin_chat_id, "text": message})
        logger.info(f"Sent abuse alert for user {user_id}")
    except Exception as e:
        logger.error(f"Failed to send abuse alert: {e}")

# Rate limit and quota are checked and consumed in a single Lua script so the
# two cannot interleave. The previous check_usage()/increment_usage() pair read
# the counter, decided, then incremented in a separate round trip: with four
# uvicorn workers two concurrent requests could both read 59 against a limit of
# 60, both pass, and both increment to 61. It also collapses six sequential
# round trips into one, which matters once Redis is not on localhost.
# KEYS: 1 ratelimit  2 daily quota  3 monthly quota (user or org)
# ARGV: 1 rate limit  2 daily limit  3 daily ttl  4 monthly limit  5 monthly ttl
#       6 monthly weight
#
# All three limits are checked before anything is incremented, so a call refused
# by the monthly budget does not burn a daily credit or rate-limit headroom.
# A monthly limit of -1 skips KEYS[3] entirely: messaging services and uncapped
# tiers never read or write a monthly counter.
#
# The monthly counter is incremented by ARGV[6] rather than always 1, so a
# shared pool (e.g. the notifications meter) can charge a different weight per
# channel - an SMS and a 5-minute voice call cost different amounts and both
# draw down the same dollar-denominated budget. The daily and rate-limit
# counters stay plain counts (weight-blind): they bound request rate, not
# spend, and mixing the two would let a handful of expensive sends silently
# eat a whole day's request allowance.
_CONSUME_LUA = """
local rl = tonumber(redis.call('GET', KEYS[1]) or '0')
if rl >= tonumber(ARGV[1]) then return {-1, rl} end

local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if used >= tonumber(ARGV[2]) then return {-2, used} end

local mlimit = tonumber(ARGV[4])
local weight = tonumber(ARGV[6])
local mused = 0
if mlimit >= 0 then
  mused = tonumber(redis.call('GET', KEYS[3]) or '0')
  if mused + weight > mlimit then return {-3, mused} end
end

local nrl = redis.call('INCR', KEYS[1])
if nrl == 1 then redis.call('EXPIRE', KEYS[1], 60) end

local nq = redis.call('INCR', KEYS[2])
if nq == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3])) end

if mlimit >= 0 then
  redis.call('INCRBY', KEYS[3], weight)
  if mused == 0 then redis.call('EXPIRE', KEYS[3], tonumber(ARGV[5])) end
end

return {0, nq}
"""

_consume_script = None


def limit_for(service: str, is_pro: bool = False, is_max: bool = False, is_plus: bool = False) -> int:
    """The daily limit that applies to this user's tier for this service."""
    if is_max:
        return MAX_QUOTA_LIMITS[service]
    if is_pro:
        return PRO_QUOTA_LIMITS[service]
    if is_plus:
        return PLUS_QUOTA_LIMITS[service]
    return QUOTA_LIMITS[service]


def monthly_limit_for(service: str, is_pro: bool = False, is_max: bool = False, is_plus: bool = False) -> int:
    """
    The monthly budget for this tier's meter, or NO_MONTHLY_LIMIT. Enterprise
    seats do not use this for the "monitor" meter - their budget is the org
    pool, see org_monthly_limit(). Org seats still use this for the shared
    "notifications" meter: pooling a per-Twilio-dollar budget into an org's
    negotiated monitor-credit pool would silently merge two unrelated budgets.
    """
    meter = MONTHLY_METER_GROUP.get(service, service)
    if meter == "notifications":
        tier = "max" if is_max else "pro" if is_pro else "plus" if is_plus else "free"
        return NOTIFICATION_MONTHLY_LIMITS[tier]

    if is_max:
        table = MAX_MONTHLY_LIMITS
    elif is_pro:
        table = PRO_MONTHLY_LIMITS
    elif is_plus:
        table = PLUS_MONTHLY_LIMITS
    else:
        table = FREE_MONTHLY_LIMITS
    return table.get(meter, NO_MONTHLY_LIMIT)


def _notification_credits(service: str, message: str | None = None) -> int:
    """
    Credit weight of one send on `service`, for the shared notifications
    pool. Only sms/whatsapp/voice_call are meaningful here; any other service
    passed in returns 1 but it is unused since try_consume only applies a
    weight when MONTHLY_METER_GROUP maps the service to "notifications".
    """
    if service == "sms":
        return SMS_CREDITS
    if service == "whatsapp":
        return WHATSAPP_CREDITS
    if service == "voice_call":
        minutes = max(1, math.ceil(len(message or "") / VOICE_CHARS_PER_MINUTE))
        return VOICE_CREDITS_PER_MINUTE * minutes
    return 1


async def org_monthly_limit(org_id: str) -> int:
    """
    The org's negotiated monthly pool, R2 as source of truth and Redis as cache.

    Orgs with no monthly_credits set are uncapped, so this ships dark: existing
    enterprise customers keep exactly the behaviour they have until a number is
    negotiated onto their record.

    Fails open. R2 being unreachable should not cut off every enterprise seat at
    once, and the daily per-seat limit still applies underneath.
    """
    r = await get_redis()
    cached = await r.get(org_limit_key(org_id))
    if cached is not None:
        return int(cached)

    try:
        org, _ = await r2_store.get_json(r2_store.org_key(org_id))
    except Exception as e:
        logger.error(f"Could not read org {org_id} for its monthly pool, allowing: {e}")
        return NO_MONTHLY_LIMIT

    limit = int((org or {}).get("monthly_credits", NO_MONTHLY_LIMIT))
    await r.setex(org_limit_key(org_id), ORG_LIMIT_CACHE_TTL, limit)
    return limit


async def invalidate_org_limit(org_id: str) -> None:
    """Call after changing an org's monthly_credits so all workers pick it up."""
    r = await get_redis()
    await r.delete(org_limit_key(org_id))


async def try_consume(
    user_id: str, service: str,
    is_pro: bool = False, is_max: bool = False, is_plus: bool = False,
    org_id: str | None = None,
    message: str | None = None,
) -> tuple[bool, int, str | None]:
    """
    Atomically check the rate limit, daily quota and monthly budget, and consume
    one unit if all three allow it.

    Returns (allowed, count, reason). On success reason is None and count is
    the new daily total. On refusal reason is "rate_limit", "quota" or
    "monthly_quota" and count is the value that blocked it. Nothing is consumed
    when refused, so a rejected request does not eat rate-limit budget - same as
    the behaviour of the check/increment pair this replaces.

    Pass org_id for enterprise seats: for the "monitor" meter their monthly
    credits come out of one shared org pool rather than a per-user budget,
    while the daily limit stays per seat. It has no effect on sms/whatsapp/
    voice_call - those always meter per-user (see monthly_limit_for) so an
    org's negotiated monitor-credit pool is never silently spent on Twilio
    sends. Pass message for voice_call so long TTS messages are weighted by
    estimated minutes rather than the 1-minute floor. Prefer try_consume_for(),
    which fills org_id/tier in from the JWT.
    """
    global _consume_script
    r = await get_redis()
    if _consume_script is None:
        # register_script sends EVALSHA and falls back to EVAL on NOSCRIPT, so
        # this stays one round trip and re-loads itself after a Redis restart.
        _consume_script = r.register_script(_CONSUME_LUA)

    limit = limit_for(service, is_pro=is_pro, is_max=is_max, is_plus=is_plus)

    meter = MONTHLY_METER_GROUP.get(service)
    weight = 1
    monthly_key_org_id = None
    if meter is None:
        monthly = NO_MONTHLY_LIMIT
    elif meter == "monitor" and org_id:
        monthly = await org_monthly_limit(org_id)
        monthly_key_org_id = org_id
    else:
        if meter == "notifications":
            weight = _notification_credits(service, message)
        monthly = monthly_limit_for(service, is_pro=is_pro, is_max=is_max, is_plus=is_plus)

    code, count = await _consume_script(
        keys=[
            f"ratelimit:{user_id}",
            daily_key(user_id, service),
            monthly_key(user_id, meter or service, monthly_key_org_id),
        ],
        args=[
            RATE_LIMIT_PER_MINUTE, limit, _seconds_until_midnight(),
            monthly, MONTHLY_KEY_TTL, weight,
        ],
    )
    code, count = int(code), int(count)

    if code == -1:
        asyncio.create_task(_send_abuse_alert_async(user_id, service))
        return False, count, "rate_limit"
    if code == -2:
        return False, count, "quota"
    if code == -3:
        return False, count, "monthly_quota"

    return True, count, None


async def try_consume_for(user, service: str, message: str | None = None) -> tuple[bool, int, str | None]:
    """
    try_consume() for an AuthenticatedUser. Every call site should use this:
    it is the only thing that guarantees an enterprise seat's org_id reaches
    the limiter, and forgetting it silently bills the user's own budget
    instead of the org pool.

    Pass message for voice_call - see try_consume().

    Deliberately duck-typed rather than importing AuthenticatedUser, to keep
    quota_manager free of a dependency on the auth layer.
    """
    return await try_consume(
        user.id, service,
        is_pro=user.is_pro, is_max=user.is_max, is_plus=user.is_plus,
        org_id=user.org_id,
        message=message,
    )


async def get_monthly_usage(
    user_id: str | None, service: str = "monitor", org_id: str | None = None
) -> int:
    """
    Usage this month against the meter `service` draws from - the org's
    total for an enterprise seat's "monitor" meter, notification credits
    (see NOTIFICATION_CREDIT_VALUE) for sms/whatsapp/voice_call.
    """
    r = await get_redis()
    meter = MONTHLY_METER_GROUP.get(service, service)
    val = await r.get(monthly_key(user_id, meter, org_id))
    return int(val) if val else 0


def daily_resets_at() -> str:
    return _next_midnight().isoformat().replace("+00:00", "Z")


def monthly_resets_at() -> str:
    return _next_month_start().isoformat().replace("+00:00", "Z")


async def get_usage_for_service(user_id: str, service: str) -> int:
    r = await get_redis()
    val = await r.get(f"quota:{user_id}:{service}")
    return int(val) if val else 0

async def get_usage(user_id: str | None = None, emails: bool = False) -> dict:
    """
    Admin snapshot of today's and this month's counters, straight from the
    enforcement keys: {user: {"daily": {...}, "monthly": {...}}}.

    One user is a handful of direct GETs. All users is a SCAN, but daily keys
    expire at midnight, so its cost tracks daily active users, not signups.
    Monthly counters are read for those same users only. Org pools are not
    included (see /orgs/me). Audio is reported as "chirp_seconds".

    emails=True swaps user ids for emails, one Auth0 lookup per user. It is
    off by default because that lookup is the slow part.
    """
    r = await get_redis()
    month = current_month()
    out: dict[str, dict] = {}

    def slot(uid: str) -> dict:
        return out.setdefault(uid, {"daily": {}, "monthly": {}})

    if user_id:
        keys = [daily_key(user_id, s) for s in QUOTA_LIMITS] + [f"audio:{user_id}:chirp3"]
        keys += [monthly_key(user_id, m) for m in set(MONTHLY_METER_GROUP.values())]
        keys += [monthly_key(user_id, "audio:chirp3")]
        slot(user_id)
    else:
        keys = []
        for pattern in ("quota:*", "audio:*", f"mquota:*:{month}"):
            keys += [k async for k in r.scan_iter(pattern, count=1000)]

    for i in range(0, len(keys), 500):
        batch = keys[i:i + 500]
        for key, val in zip(batch, await r.mget(batch)):
            if not val:
                continue
            prefix, _, rest = key.partition(":")
            if prefix == "quota":
                uid, _, service = rest.partition(":")
                slot(uid)["daily"][service] = int(val)
            elif prefix == "audio":
                uid, _, _provider = rest.partition(":")
                slot(uid)["daily"]["chirp_seconds"] = round(float(val))
            elif prefix == "mquota":
                uid, _, meter = rest.rpartition(":")[0].partition(":")
                # Monthly audio meters are seconds; everything else is a count
                # (notifications are weighted credits, see NOTIFICATION_CREDIT_VALUE).
                slot(uid)["monthly"][meter.replace("audio:chirp3", "chirp_seconds")] = (
                    round(float(val)) if meter.startswith("audio:") else int(val)
                )

    if emails:
        from auth0_manager import get_email_by_id

        async def to_email(uid: str) -> str:
            try:
                return await get_email_by_id(uid) or uid
            except Exception as e:
                logger.error(f"Error fetching email for {uid}: {e}")
                return uid

        keys_ = list(out)
        names = await asyncio.gather(*(to_email(u) for u in keys_))
        out = {name: out[u] for name, u in zip(names, keys_)}

    return out

async def check_provider_seconds_quota(
    user_id: str, audio_seconds: float, provider: str,
    is_pro: bool = False, is_max: bool = False, is_plus: bool = False,
) -> bool:
    tier = "max" if is_max else "pro" if is_pro else "plus" if is_plus else "free"
    limit = CHIRP_SECOND_LIMITS[tier]

    r = await get_redis()
    val = await r.get(f"audio:{user_id}:{provider}")
    current = float(val) if val else 0.0
    if current + audio_seconds > limit:
        return True

    if provider == "chirp3":
        mlimit = CHIRP_MONTHLY_SECOND_LIMITS[tier]
        if mlimit != NO_MONTHLY_LIMIT:
            mval = await r.get(monthly_key(user_id, f"audio:{provider}"))
            if (float(mval) if mval else 0.0) + audio_seconds > mlimit:
                return True
    return False

async def increment_provider_seconds(user_id: str, audio_seconds: float, provider: str) -> float:
    r = await get_redis()
    key = f"audio:{user_id}:{provider}"
    new_total = await r.incrbyfloat(key, audio_seconds)
    # Only set TTL on first write
    if new_total == audio_seconds:
        await r.expire(key, _seconds_until_midnight())
    if provider == "chirp3":
        mkey = monthly_key(user_id, f"audio:{provider}")
        if await r.incrbyfloat(mkey, audio_seconds) == audio_seconds:
            await r.expire(mkey, MONTHLY_KEY_TTL)
    return new_total
