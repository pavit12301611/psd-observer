# observer_ollama/__main__.py
import argparse
import logging
import os
from .server import run_server
from .ollama_client import set_ollama_destination

# Setup root logging configuration
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger('ollama-proxy')

# --- New: Helper function for reading boolean environment variables ---
def get_bool_env(var_name, default=False):
    """Reads an environment variable and interprets it as a boolean."""
    val = os.environ.get(var_name, str(default))
    return val.lower() in ['true', '1', 't', 'y', 'yes']

def main():
    """Main entry point for the Ollama Proxy."""
    parser = argparse.ArgumentParser(
        description="A proxy for Ollama with OpenAI API compatibility.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    server_group = parser.add_argument_group('Server Configuration')
    server_group.add_argument("--port", type=int, default=os.environ.get("PORT", "3838"), help="Port to run the proxy server on. Overrides PORT env var.")
    server_group.add_argument("--dev", action="store_true", help="Enable development mode (e.g., allows all CORS origins).")

    # --- Modified: SSL configuration using the new pattern ---
    ssl_group = parser.add_argument_group('SSL Configuration')
    # The default is now read from the environment. Flag overrides it.
    ssl_group.add_argument(
        "--ssl",
        dest="use_ssl",
        action=argparse.BooleanOptionalAction,
        default=get_bool_env('ENABLE_SSL', False),
        help="Enable/disable SSL (--ssl or --no-ssl). Overrides ENABLE_SSL env var."
    )
    ssl_group.add_argument("--cert-dir", default="./certs", help="Directory to store self-signed certificates.")

    # --- New: Legacy Translation configuration group ---
    translation_group = parser.add_argument_group('Legacy Ollama Support')
    translation_group.add_argument(
        "--legacy-translation",
        dest="enable_legacy_translation",
        action=argparse.BooleanOptionalAction,
        default=get_bool_env('ENABLE_LEGACY_TRANSLATION', True),
        help="Enable translation to legacy /api/generate endpoint (--legacy-translation or --no-legacy-translation)."
    )
    
    ollama_group = parser.add_argument_group('Ollama Destination Configuration')
    ollama_group.add_argument("--ollama-host", default=os.environ.get("OLLAMA_SERVICE_HOST", "localhost"), help="The hostname of the Ollama service to proxy to.")
    ollama_group.add_argument("--ollama-port", type=int, default=os.environ.get("OLLAMA_SERVICE_PORT", "11434"), help="The port of the Ollama service.")
    
    log_group = parser.add_argument_group('Logging')
    log_group.add_argument("--debug", action="store_true", help="Enable debug logging for all modules.")
    
    args = parser.parse_args()
    
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG) # Configure root logger
        logger.info("Debug logging enabled.")

    # Log the final, resolved configuration
    logger.info(f"--- Configuration ---")
    logger.info(f"SSL Enabled: {args.use_ssl}")
    logger.info(f"Legacy Translation Enabled: {args.enable_legacy_translation}")
    logger.info(f"---------------------")

    set_ollama_destination(args.ollama_host, args.ollama_port)
    
    # Pass all resolved arguments to the server runner
    run_server(
        port=args.port, 
        cert_dir=args.cert_dir, 
        dev_mode=args.dev, 
        use_ssl=args.use_ssl,
        enable_legacy_translation=args.enable_legacy_translation
    )

if __name__ == "__main__":
    main()
