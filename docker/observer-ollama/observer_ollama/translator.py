# ollama_proxy/translator.py
import json
import time
import logging

logger = logging.getLogger('ollama-proxy.translator')

def translate_request_to_ollama(request_body_bytes):
    """
    Translates an OpenAI-compatible /v1/chat/completions request 
    to an Ollama-compatible /api/generate request.
    
    Returns a tuple of (new_path, new_body_bytes).
    """
    try:
        request_data = json.loads(request_body_bytes)
        model = request_data.get('model', '')
        
        # Default to a passthrough if the structure is not as expected
        if not ('messages' in request_data and request_data['messages']):
             return "/v1/chat/completions", request_body_bytes

        first_message = request_data['messages'][0]
        content = first_message.get('content', '')
        
        prompt_text = ""
        images = []
        
        if isinstance(content, str):
            prompt_text = content
        elif isinstance(content, list):
            for item in content:
                if item.get('type') == 'text':
                    prompt_text += item.get('text', '')
                elif item.get('type') == 'image_url':
                    image_url = item.get('image_url', {}).get('url', '')
                    if image_url.startswith('data:image'):
                        base64_data = image_url.split(',', 1)[1]
                        images.append(base64_data)

        ollama_request = {
            'model': model,
            'prompt': prompt_text,
            'stream': request_data.get('stream', False)
        }
        if images:
            ollama_request['images'] = images
        
        # Forward common parameters
        for key in ['temperature', 'top_p', 'top_k', 'seed']:
            if key in request_data:
                ollama_request[key] = request_data[key]

        logger.info(f"Translated OpenAI request to Ollama native format for model '{model}'")
        return "/api/generate", json.dumps(ollama_request).encode('utf-8')

    except Exception as e:
        logger.error(f"Could not translate request to Ollama format: {e}")
        # If translation fails, pass it through and let Ollama handle the error
        return "/v1/chat/completions", request_body_bytes


def translate_response_to_openai(ollama_response_bytes, model):
    """
    Translates a non-streaming Ollama /api/generate response to an 
    OpenAI-compatible /v1/chat/completions response.
    """
    try:
        ollama_response = json.loads(ollama_response_bytes)
        
        openai_response = {
            "id": f"chatcmpl-{time.time()}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": ollama_response.get("model", model),
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": ollama_response.get("response", "")
                    },
                    "finish_reason": "stop"
                }
            ],
            "usage": {
                # Ollama provides detailed usage, but we'll fake it for compatibility
                "prompt_tokens": ollama_response.get("prompt_eval_count", -1),
                "completion_tokens": ollama_response.get("eval_count", -1),
                "total_tokens": -1,
            }
        }
        logger.info("Translated Ollama native response back to OpenAI format")
        return json.dumps(openai_response).encode('utf-8')
    except Exception as e:
        logger.error(f"Could not translate Ollama response to OpenAI format: {e}")
        # Return original response if translation fails
        return ollama_response_bytes
