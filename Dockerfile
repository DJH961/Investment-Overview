# syntax=docker/dockerfile:1
# v6 image: React frontend build + Python/FastAPI backend in one container.
# Build context is the repo root.

# --- Stage 1: build the React app ------------------------------------------
FROM node:22-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: runtime ------------------------------------------------------
FROM python:3.12-slim AS runtime
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /usr/local/bin/uv

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
