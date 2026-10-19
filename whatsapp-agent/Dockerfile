# Free self-hosting (old laptop / Raspberry Pi / free-tier VM).
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY .env.example ./
# Session + data survive restarts via volumes (see docker-compose.yml).
# auth_info/ is the WhatsApp login for the agent number — keep it private.
VOLUME ["/app/auth_info", "/app/data"]
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "src/index.js"]
