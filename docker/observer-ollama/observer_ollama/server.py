# ollama_proxy/server.py
import socketserver
import ssl
import signal
import sys
import logging
from .ssl_helper import prepare_certificates
from .network_helper import get_local_ip
from .handler import OllamaProxyHandler

logger = logging.getLogger('ollama-proxy.server')


def run_server(port, cert_dir, dev_mode, use_ssl, enable_legacy_translation):
    """Configures and starts the proxy server (HTTPS or HTTP)."""
    protocol = "https" if use_ssl else "http"
    logger.info(f"--- Ollama {protocol.upper()} Proxy ---")

    class CustomThreadingTCPServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        def __init__(self, server_address, RequestHandlerClass, bind_and_activate=True):
            # Store all config values on the server instance
            self.dev_mode = dev_mode
            # --- New: Store the translation setting ---
            self.enable_legacy_translation = enable_legacy_translation
            super().__init__(server_address, RequestHandlerClass, bind_and_activate)

    httpd = CustomThreadingTCPServer(('', port), OllamaProxyHandler)
    
    # Conditionally wrap the server socket with SSL
    if use_ssl:
        logger.info("SSL is enabled. Preparing certificates...")
        try:
            cert_path, key_path = prepare_certificates(cert_dir)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_cert_chain(certfile=cert_path, keyfile=key_path)
            httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
            logger.info("Server is wrapped with SSL.")
        except Exception as e:
            logger.error(f"Failed to initialize SSL: {e}")
            sys.exit(1)
    else:
        logger.info("SSL is disabled. The server will run over plain HTTP.")

    # Setup graceful shutdown
    def signal_handler(sig, frame):
        logger.info("Shutdown signal received. Closing server...")
        httpd.server_close()
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Display server information
    local_ip = get_local_ip()
    print(f"\n\033[1m OLLAMA-PROXY ({protocol.upper()}) \033[0m ready")
    print(f"  ➜  \033[36mLocal:   \033[0m{protocol}://localhost:{port}/")
    print(f"  ➜  \033[36mNetwork: \033[0m{protocol}://{local_ip}:{port}/")
    print("\n  Proxying to Ollama. Use Ctrl+C to stop.")
    
    # Start the server
    try:
        httpd.serve_forever()
    except Exception as e:
        logger.error(f"Server failed to start: {e}")
        sys.exit(1)

