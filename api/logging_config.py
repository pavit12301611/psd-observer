import logging
import sys
from contextvars import ContextVar

# The distribution is "python-json-logger" but it imports as "pythonjsonlogger".
# 3.1+ exposes JsonFormatter at .json; older releases only at .jsonlogger.
try:
    from pythonjsonlogger.json import JsonFormatter
except ImportError:  # pragma: no cover - older python-json-logger
    from pythonjsonlogger.jsonlogger import JsonFormatter

# Set per-request by the correlation-ID middleware in api.py. With 4 uvicorn
# workers interleaving on one stdout, this is what makes a single request
# followable through the logs.
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")


class RequestIdFilter(logging.Filter):
    """Injects the current request id into every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True


def setup_logging():
    """
    Configures logging to output structured JSON.
    This is called once from api.py at import time.
    """
    # Get the root logger
    logger = logging.getLogger()
    logger.setLevel(logging.INFO) # Set the lowest level you want to capture

    # Remove any existing handlers
    if logger.hasHandlers():
        logger.handlers.clear()

    # Create a handler to write to standard output (which Docker captures)
    logHandler = logging.StreamHandler(sys.stdout)
    logHandler.addFilter(RequestIdFilter())

    # Use a custom formatter for JSON output
    # Add any fields you want to be standard in every log message here
    formatter = JsonFormatter(
        '%(asctime)s %(name)s %(levelname)s %(message)s %(module)s %(funcName)s %(lineno)d %(request_id)s'
    )

    logHandler.setFormatter(formatter)
    logger.addHandler(logHandler)

    # Prevent propagation to the old root logger
    logging.getLogger().propagate = False

    logging.info("Structured JSON logging configured.")

# Example usage (you'll call this from api.py)
if __name__ == '__main__':
    setup_logging()
    logging.warning("This is a test warning message.", extra={'test_key': 'test_value'})
    logging.info("This is an info message.")
