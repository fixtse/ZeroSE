# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=assistant-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm exec tsc

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/fixtse/node-assistant"
LABEL org.opencontainers.image.description="Fixt personal assistant with Codex and Home Assistant integrations"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg poppler-utils catdoc ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=assistant-pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --store-dir=/pnpm/store
COPY --from=build /app/dist ./dist
COPY assets/icon.png ./assets/icon.png
USER node
CMD ["node", "dist/src/main.js"]
