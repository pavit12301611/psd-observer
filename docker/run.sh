#!/bin/bash

# A simple script to build and serve the Observer webapp locally.
# Ideal for users who already have an OpenAI-compatible API
# (like Llama.cpp, vLLM, etc.) and just need the UI.

# --- Prerequisite Check ---
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "--------------------------------------------------"
  echo "ERROR: Node.js and npm are required to run this script."
  echo "Please install them to continue."
  echo "You can download Node.js from: https://nodejs.org/"
  echo "--------------------------------------------------"
  exit 1
fi

echo "✅ Node.js and npm found."

# To disable auth
export VITE_DISABLE_AUTH=false

# Navigate to the app directory
cd ../app || { echo "Error: 'app' directory not found. Make sure you are in the docker/ directory."; exit 1; }

# Check if node_modules exists, if not, install dependencies
if [ ! -d "node_modules" ]; then
  echo "🚀 Node modules not found. Running 'npm install' (this may take a moment)..."
  npm install
fi

echo "📦 Building the webapp for production..."
npm run build

echo "🌐 Starting the webapp server on http://localhost:8080"
echo "You can now connect to your own local model endpoint from the UI."
echo "Press Ctrl+C to stop the server."
npm run preview
