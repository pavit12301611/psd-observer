# ollama_proxy/ssl_helper.py
import os
import sys
import subprocess
import logging
from pathlib import Path
from .network_helper import get_local_ip

logger = logging.getLogger('ollama-proxy.ssl')

def prepare_certificates(cert_dir):
    """Prepare SSL certificates, generating them if they don't exist."""
    cert_path = Path(cert_dir) / "cert.pem"
    key_path = Path(cert_dir) / "key.pem"
    config_path = Path(cert_dir) / "openssl.cnf"
    
    os.makedirs(cert_dir, exist_ok=True)
    
    if cert_path.exists() and key_path.exists():
        logger.info(f"Using existing certificates from {cert_dir}")
        return str(cert_path), str(key_path)

    logger.info("Generating new self-signed SSL certificates...")
    local_ip = get_local_ip()
    
    config_content = f"""
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = localhost

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = {local_ip}
    """
    with open(config_path, 'w') as f:
        f.write(config_content)
    
    cmd = [
        "openssl", "req", "-x509", 
        "-newkey", "rsa:4096", 
        "-sha256", 
        "-days", "365", 
        "-nodes", 
        "-keyout", str(key_path), 
        "-out", str(cert_path),
        "-config", str(config_path)
    ]
    
    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        logger.debug(f"OpenSSL stdout: {result.stdout}")
        logger.info(f"Certificates successfully generated at {cert_dir}")
    except FileNotFoundError:
        logger.error("`openssl` command not found. Please install OpenSSL.")
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        logger.error(f"Failed to generate certificates: {e.stderr}")
        sys.exit(1)
        
    return str(cert_path), str(key_path)
