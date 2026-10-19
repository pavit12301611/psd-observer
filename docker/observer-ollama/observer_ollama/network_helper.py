# ollama_proxy/network_helper.py
import socket
import logging

logger = logging.getLogger('ollama-proxy.network')

def get_local_ip():
    """Get the local IP address for network access."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except Exception as e:
        logger.warning(f"Could not determine local IP, defaulting to 127.0.0.1: {e}")
        return "127.0.0.1"
