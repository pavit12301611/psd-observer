# 🐳 Docker Setup (Deprecated)

https://github.com/user-attachments/assets/c5af311f-7e10-4fde-9321-bb98ceebc271


> ✨ **Major Update: Simpler Setup & More Flexibility!**
> The `observer-ollama` service no longer requires SSL by default. This means **no more browser security warnings** for a standard local setup! It now also supports any backend that uses a standard OpenAI-compatible (`v1/chat/completions`) endpoint, like Llama.cpp.


This method uses Docker Compose to run everything you need in containers: the Observer WebApp, the `observer-ollama` translator, and a local Ollama instance. This is the easiest way to get a 100% private, local-first setup.

**Prerequisites:**
*   [Docker](https://docs.docker.com/get-docker/) installed.
*   [Docker Compose](https://docs.docker.com/compose/install/) installed.

**Instructions:**

1.  **Clone the repository and start the services:**
    ```bash
    git clone https://github.com/Roy3838/Observer.git
    cd Observer/docker
    docker-compose up --build
    ```

2.  **Access the Local WebApp:**
    *   Open your browser to **`http://localhost:8080`**. This is your self-hosted version of the Observer app.

3.  **Connect to your Ollama service:**
    *   In the app's header/settings, set the Model Server Address to **`http://localhost:3838`**. This is the `observer-ollama` translator that runs in a container and communicates with Ollama for you.

4.  **Pull Ollama Models:**
    *   Navigate to the "Models" tab and click "Add Model". This opens a terminal to your Ollama instance.
    *   Pull any model you need, for example:
        ```bash
        ollama run gemma3:4b # <- highly recommended model!
        ```

For NVIDIA GPUs: it's recommended to edit `docker/docker-compose.yml` and explicitly add gpu runtime to the ollama docker container.
Add these to the ollama section of `docker/docker-compose.yml`:
```
    volumes:
      - ollama_data:/root/.ollama
    # ADD THIS SECTION
    runtime: nvidia
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    # UP TO HERE
    ports:
      - "11434:11434"
```

**To Stop the Docker Setup:**
```bash
cd docker && docker-compose down
```

---
## ⚙️ Configuration

To customize your setup (e.g., enable SSL to access from `app.observer-ai.com`, disabling docker exec feature), simply edit the `environment:` section in your `docker/docker-compose.yml` file. All options are explained with comments directly in the file.
