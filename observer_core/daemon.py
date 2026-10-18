"""Headless runtime: `observer-core daemon` / `observer-core-daemon`.

Runs every enabled agent under the asyncio scheduler without a GUI. SIGINT and
SIGTERM stop the loop cleanly, release sensors and close the database.
"""

from __future__ import annotations

import asyncio
import signal
import sys

from .app import ObserverApp
from .logging_setup import bind, setup_logging


async def _run(app: ObserverApp) -> int:
    log = bind("daemon")
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _request_stop(signame: str) -> None:
        log.info(f"received {signame}; shutting down agents")
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _request_stop, sig.name)
        except (NotImplementedError, RuntimeError):  # pragma: no cover - Windows
            pass

    agents = [a for a in app.agents.list() if a.enabled]
    if not agents:
        log.warning("no enabled agents; nothing to do. Enable one in the GUI or with `observer-core agent enable <id>`.")
    sched = app.start_monitoring(on_status=lambda st: log.debug(f"{st.name}: {st.state}"))
    await sched.start(agents)
    log.info(f"daemon running with {len(agents)} agent(s); Ctrl+C to stop")
    app.events.record(f"daemon started with {len(agents)} agent(s)", level="OK", kind="daemon")
    try:
        await stop.wait()
    finally:
        await sched.stop()
        app.stop_monitoring()
        app.events.record("daemon stopped", level="INFO", kind="daemon")
        app.db.close()
        log.info("database closed; bye")
    return 0


def run_daemon() -> int:
    setup_logging(json_logs=True)
    app = ObserverApp()
    app.seed_examples()
    try:
        return asyncio.run(_run(app))
    except KeyboardInterrupt:  # belt and braces: the signal handler normally catches it
        app.close()
        return 0


def main() -> None:
    sys.exit(run_daemon())


if __name__ == "__main__":
    main()
