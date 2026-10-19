#!/usr/bin/env python3
import os
import json
import logging
import asyncio
import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from auth import verify_token_from_string
from quota_manager import check_provider_seconds_quota, increment_provider_seconds

logger = logging.getLogger("transcriptions")

transcriptions_router = APIRouter()

DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")

# Deepgram V1 Listen — nova-2 multilingual (Spanish + English auto-detect).
# Frontend must send raw PCM: linear16, 16 kHz, mono (not WebM/Opus).
DEEPGRAM_URL = (
    "wss://api.deepgram.com/v1/listen"
    "?model=nova-2"
    "&language=multi"
    "&interim_results=true"
    "&endpointing=300"
    "&encoding=linear16"
    "&sample_rate=16000"
)

# linear16 @ 16 kHz mono = 16000 samples/sec × 2 bytes/sample
_BYTES_PER_SEC = 32_000

# Force reconnect after this many seconds so quota is checked at each session boundary
_SESSION_LIMIT_SECS = 10 * 60  # 10 minutes


@transcriptions_router.websocket("/v1/audio/transcriptions/stream")
async def stream_transcription(websocket: WebSocket):
    """
    WebSocket endpoint for real-time streaming transcription via Deepgram nova-2.

    Protocol:
    1. Client connects
    2. Client sends JSON auth: {"token": "jwt_token_here"}
    3. Client streams raw PCM audio bytes (linear16, 16 kHz, mono)
    4. Server sends: {"text": "...", "is_final": true/false}
       On unexpected Deepgram drop: {"reconnect": true}
    """
    await websocket.accept()
    logger.info("WebSocket transcription connection accepted")

    user = None
    total_bytes = 0

    try:
        # 1. Auth via first message
        try:
            auth_msg = await asyncio.wait_for(websocket.receive_json(), timeout=10.0)
        except asyncio.TimeoutError:
            logger.warning("WebSocket auth timeout")
            await websocket.close(code=4001, reason="Auth timeout")
            return

        token = auth_msg.get("token")
        if not token:
            await websocket.close(code=4001, reason="No token provided")
            return

        # 2. Verify token
        user = await verify_token_from_string(token)
        if not user:
            await websocket.close(code=4001, reason="Unauthorized")
            return

        logger.info(f"WebSocket authenticated: user={user.id}")

        # 3. Check config
        if not DEEPGRAM_API_KEY:
            logger.error("DEEPGRAM_API_KEY not configured")
            await websocket.close(code=1011, reason="Server configuration error")
            return

        # 4. Check transcription quota before opening the stream
        if await check_provider_seconds_quota(
            user.id, 0, "chirp3",
            is_pro=user.is_pro, is_max=user.is_max, is_plus=user.is_plus,
        ):
            logger.warning(f"Quota exceeded: user={user.id}")
            await websocket.close(code=4029, reason="Transcription quota exceeded")
            return

        # 5. Connect to Deepgram and relay
        dg_headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}
        dg_dropped = False
        timer_expired = False

        async with websockets.connect(DEEPGRAM_URL, additional_headers=dg_headers) as dg_ws:

            async def forward_audio():
                """Browser → Deepgram: relay raw PCM bytes."""
                nonlocal total_bytes
                try:
                    while True:
                        msg = await websocket.receive()
                        if msg["type"] == "websocket.disconnect":
                            break
                        if "bytes" in msg and msg["bytes"]:
                            total_bytes += len(msg["bytes"])
                            await dg_ws.send(msg["bytes"])
                except WebSocketDisconnect:
                    pass
                except Exception as e:
                    logger.error(f"Audio forward error: {e}")
                finally:
                    # Tell Deepgram we're done sending audio
                    try:
                        await dg_ws.send(json.dumps({"type": "CloseStream"}))
                    except Exception:
                        pass

            async def receive_transcripts():
                """Deepgram → Browser: relay transcript events."""
                nonlocal dg_dropped
                try:
                    async for raw in dg_ws:
                        msg = json.loads(raw)
                        if msg.get("type") != "Results":
                            continue
                        transcript = (
                            msg.get("channel", {})
                            .get("alternatives", [{}])[0]
                            .get("transcript", "")
                        )
                        if transcript:
                            is_final = msg.get("is_final", False)
                            await websocket.send_json({"text": transcript, "is_final": is_final})

                except websockets.exceptions.ConnectionClosed as e:
                    logger.info(f"Deepgram connection closed: {e}")
                    dg_dropped = True
                except Exception as e:
                    logger.error(f"Transcript receive error: {e}")
                    dg_dropped = True

            fwd = asyncio.create_task(forward_audio())
            rcv = asyncio.create_task(receive_transcripts())
            timer = asyncio.create_task(asyncio.sleep(_SESSION_LIMIT_SECS))

            # Run until any of the three exits, then cancel the rest
            done, pending = await asyncio.wait(
                {fwd, rcv, timer}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

            timer_expired = timer in done

        # 10-minute session cap hit — flush quota now, then tell client to reconnect
        if timer_expired:
            if total_bytes > 0:
                audio_seconds = total_bytes / _BYTES_PER_SEC
                logger.info(f"Session limit reached: user={user.id}, {audio_seconds:.1f}s — signaling reconnect")
                await increment_provider_seconds(user.id, audio_seconds, "chirp3")
                total_bytes = 0  # prevent double-counting in finally
            try:
                await websocket.send_json({"reconnect": True})
                await websocket.close()
            except Exception:
                pass

        # Deepgram dropped unexpectedly — signal client to reconnect
        elif dg_dropped:
            try:
                logger.info("Deepgram dropped, signaling client to reconnect")
                await websocket.send_json({"reconnect": True})
                await websocket.close()
            except Exception:
                pass

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}", exc_info=True)
    finally:
        if user and total_bytes > 0:
            audio_seconds = total_bytes / _BYTES_PER_SEC
            logger.info(f"Stream ended: user={user.id}, {total_bytes} bytes ({audio_seconds:.1f}s)")
            await increment_provider_seconds(user.id, audio_seconds, "chirp3")
        try:
            await websocket.close()
        except Exception:
            pass
