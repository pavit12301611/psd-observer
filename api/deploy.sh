#!/bin/bash
set -e

echo "Tagging current image as backup..."
docker tag api-observer-api:latest api-observer-api:backup 2>/dev/null || echo "No existing image to backup, continuing..."

echo "Building and deploying..."
if docker compose up -d --build; then
    echo "Deploy successful."
else
    echo "Deploy failed! Rolling back..."
    docker tag api-observer-api:backup api-observer-api:latest
    docker compose up -d --no-build
    echo "Rolled back to previous version."
    exit 1
fi
