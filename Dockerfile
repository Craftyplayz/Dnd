# Battle Map Studio. Build: docker compose build   Run: docker compose up -d
# Stage 1 bundles the front end into dist/index.html (python build.py, stdlib only).
FROM python:3.12-slim AS build
WORKDIR /build
COPY build.py schema.json ./
COPY src ./src
# main.js may import a sample scene as its fallback, so samples are part of the build input.
COPY samples ./samples
RUN python build.py

# Stage 2: only what server.py needs at runtime.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app
# Non-root user. /data is created and owned by it before VOLUME, so a fresh named volume
# inherits that ownership and is writable. (A host bind mount must be chowned to uid 10001.)
RUN groupadd --system --gid 10001 bms \
 && useradd --system --uid 10001 --gid bms --home-dir /app --no-create-home --shell /usr/sbin/nologin bms \
 && mkdir -p /data \
 && chown bms:bms /data \
 && chmod 700 /data
COPY server.py config.json schema.json ./
COPY prompts ./prompts
COPY --from=build /build/dist ./dist
USER bms
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8080'), timeout=4)"]
CMD ["python", "server.py"]
