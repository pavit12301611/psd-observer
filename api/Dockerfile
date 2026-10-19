# Multi-stage build for Observer API
FROM python:3.11-slim as base

# Set working directory
WORKDIR /app

# ffmpeg is required to transcode captured video to H.264/AAC mp4,
# which WhatsApp requires (Twilio rejects other codecs with error 63021)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY *.py ./
COPY *.html ./

# Create necessary directories
RUN mkdir -p /app/logs

# Expose port
EXPOSE 3839

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:3839/')"

# Run the application
CMD ["python", "api.py", "--port", "3839"]
