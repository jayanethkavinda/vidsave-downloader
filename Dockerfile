FROM node:20-bookworm-slim

# Install Python, FFmpeg, and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp nightly and curl-cffi for Cloudflare TLS impersonation
RUN python3 -m pip install --no-cache-dir --break-system-packages -U yt-dlp curl-cffi

WORKDIR /app

# Copy server dependencies & install
COPY server/package*.json ./server/
RUN cd server && npm install

# Copy server application code
COPY server ./server

# Expose API Port
EXPOSE 5000

ENV PORT=5000
ENV NODE_ENV=production

# Start Backend Server
WORKDIR /app/server
CMD ["npm", "start"]
