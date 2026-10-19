import requests
import json
import sys

# Disable SSL warnings for self-signed certificates
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def test_proxy():
    proxy_url = "https://localhost:3838"
    
    print(f"Testing connection to {proxy_url}...")
    
    # Test basic connectivity
    try:
        # Use verify=False for self-signed certs
        response = requests.get(f"{proxy_url}/api/tags", verify=False)
        print(f"✅ HTTPS connection successful (Status: {response.status_code})")
        
        # Check if we got a valid response from Ollama
        if response.status_code == 200:
            models = response.json()
            print(f"✅ Ollama communication successful!")
            print(f"Available models:")
            for model in models['models']:
                print(f"  - {model['name']}")
        else:
            print(f"❌ Ollama returned error: {response.text}")
            
    except requests.exceptions.SSLError as e:
        print(f"❌ SSL Error: {e}")
    except requests.exceptions.ConnectionError as e:
        print(f"❌ Connection Error: {e}")
    except Exception as e:
        print(f"❌ Unexpected error: {e}")

if __name__ == "__main__":
    test_proxy()
