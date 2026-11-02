# syntax=docker/dockerfile:1
# v6 image: React frontend build + Python/FastAPI backend in one container.
# Build context is the repo root.

# --- Stage 1: build the React app ------------------------------------------
# Base images are pinned by digest (the tag is kept for readability); Dependabot
# (docker ecosystem) proposes updates.
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: runtime ------------------------------------------------------
FROM python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159 AS runtime
COPY --from=ghcr.io/astral-sh/uv:0.5@sha256:7bff3c3776ec467fc1437960f2c469d8beb30f536a6465a3350c647ccd260ec2 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

# Non-root user; /data is the only writable place (plus tmpfs /tmp).
RUN useradd --system --uid 10001 --create-home --home-dir /home/app app \
    && mkdir -p /data /app && chown app:app /data /app

WORKDIR /app/backend

# Dependencies first (cached until pyproject/uv.lock change).
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --extra encrypted --no-install-project

# Application code. Editable install keeps alembic.ini + migrations/ next to
# the package, which the boot-time migration step relies on.
COPY backend/ ./
RUN uv sync --frozen --no-dev --extra encrypted \
    && chown -R app:app /app

COPY --from=frontend /build/dist /app/frontend

ENV PATH="/app/backend/.venv/bin:$PATH" \
    INV_DASHBOARD_SERVER_MODE=true \
    INV_DASHBOARD_SCHEDULER_ENABLED=true \
    INV_DASHBOARD_ENCRYPT_SYNCED_TIERS=true \
    INV_DASHBOARD_FRONTEND_DIST=/app/frontend \
    INV_DASHBOARD_DB_PATH=/data/app.sqlite \
    INV_DASHBOARD_LOG_DIR=/data/logs \
    INV_DASHBOARD_HOST=0.0.0.0 \
    INV_DASHBOARD_PORT=8000

USER app
EXPOSE 8000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"

CMD ["inv-dashboard-server"]
