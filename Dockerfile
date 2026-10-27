# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@11.28.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN --mount=type=cache,id=assistant-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
# Independent stages keep backend-only changes out of the frontend build cache.
FROM dependencies AS backend
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm exec tsc

FROM dependencies AS frontend
COPY web ./web
RUN pnpm --filter @zero/admin build

FROM node:26-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/fixtse/node-assistant"
LABEL org.opencontainers.image.description="Fixt personal assistant with Codex and Home Assistant integrations"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg poppler-utils catdoc ca-certificates python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/tts \
    && /opt/tts/bin/pip install --no-cache-dir edge-tts==7.3.0
ENV PATH="/opt/tts/bin:${PATH}"
WORKDIR /app
RUN npm install --global pnpm@11.28.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN --mount=type=cache,id=assistant-pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter fixt-assistant --store-dir=/pnpm/store
COPY --from=backend /app/dist ./dist
COPY --from=frontend /app/web/out ./web/out
COPY assets/icon.png ./assets/icon.png
COPY drizzle ./drizzle
USER node
CMD ["node", "dist/src/main.js"]
