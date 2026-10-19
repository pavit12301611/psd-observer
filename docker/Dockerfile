# Stage 1: Build the Vite application
FROM node:20-alpine as builder

ARG VITE_DISABLE_AUTH
# Set it as an environment variable for the subsequent RUN commands
ENV VITE_DISABLE_AUTH=${VITE_DISABLE_AUTH}

WORKDIR /app
COPY app/package.json app/package-lock.json* ./
RUN npm install
COPY app/ .
RUN npm run build

# Stage 2: Nginx + Python Proxy ONLY
FROM nginx:alpine

# Install Python, pip, openssl (for cert generation), supervisor
# NO curl, NO gcompat, NO Ollama installation here
RUN apk add --no-cache python3 py3-pip openssl supervisor docker-cli

# --- Nginx Setup ---
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80

# --- Python Proxy Setup ---
RUN mkdir -p /opt/observer-ollama /var/log/supervisor
COPY ./observer-ollama /opt/observer-ollama/
WORKDIR /opt/observer-ollama
RUN pip3 install --break-system-packages .
EXPOSE 3838

# --- Tell user webpage is available ---
COPY docker/print_info.sh /usr/local/bin/print_info.sh
RUN chmod +x /usr/local/bin/print_info.sh

# --- Supervisor Setup ---
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf 
WORKDIR /

# Command to run Supervisor
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
