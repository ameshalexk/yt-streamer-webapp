# syntax=docker/dockerfile:1
ARG BUILD_FROM=node:22-bookworm-slim
FROM ${BUILD_FROM}

ARG APP_REF=00155b080f724ac5941632191ef239b5846b7753
ARG YTDLP_VERSION=2026.08.19
LABEL org.opencontainers.image.source="https://github.com/ameshalexk/yt-streamer-webapp" \
      org.opencontainers.image.revision="${APP_REF}"

# Keep this compatible with the Supervisor's Docker API build path.
RUN set -eu; \
    if command -v apt-get >/dev/null 2>&1; then \
      apt-get update; \
      apt-get install -y --no-install-recommends \
        ca-certificates curl ffmpeg python3 python3-venv; \
      rm -rf /var/lib/apt/lists/*; \
    else \
      apk add --no-cache \
        ca-certificates curl ffmpeg nodejs npm python3 py3-pip py3-virtualenv; \
    fi; \
    python3 -m venv /opt/yt-dlp; \
    /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp==${YTDLP_VERSION}"

WORKDIR /app
RUN set -eu; \
    curl --fail --location --retry 3 \
      "https://codeload.github.com/ameshalexk/yt-streamer-webapp/tar.gz/${APP_REF}" \
      -o /tmp/source.tar.gz; \
    tar -xzf /tmp/source.tar.gz --strip-components=2 -C /app \
      "yt-streamer-webapp-${APP_REF}/webapp"; \
    rm /tmp/source.tar.gz; \
    npm ci --omit=dev --strict-ssl=true; \
    npm cache clean --force; \
    npm run check

COPY run.py /run-streamer.py
ENV HOST=0.0.0.0 PORT=8099 DATA_DIR=/data \
    LIBRARY_DIR=/data/library APNE_ICLOUD_DIR=/data/apne-exports \
    YOUTUBE_OAUTH_TOKEN_FILE=/data/youtube-oauth.json \
    YTDLP_PATH=/opt/yt-dlp/bin/yt-dlp VIDEO_ENCODER=libx264 \
    DESKTOP_STREAM_ENABLED=0 DESKTOP_INPUT_ENABLED=0 MAX_FPS=30
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e 'fetch("http://127.0.0.1:8099/api/health").then(async r => { if (!r.ok || !(await r.json()).ok) process.exit(1); }).catch(() => process.exit(1))'
CMD ["python3", "/run-streamer.py"]
