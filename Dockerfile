# ── Stage 1: Build React frontend ────────────────────────────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./

# API lives on same origin, so use relative path
ENV VITE_API_URL=""
RUN npm run build

# ── Stage 2: Python backend + serve React dist ────────────────────────────────
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .

# Copy built React app into backend/dist so Flask can serve it
COPY --from=frontend-build /app/frontend/dist ./dist

# Persistent data directory for leverage config & trade history
RUN mkdir -p /app/data

EXPOSE 8080

CMD ["gunicorn", "main:app", "-b", "0.0.0.0:8080", "--workers", "2", "--timeout", "120"]
