FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils catdoc ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm exec tsc --rootDir . --outDir dist --module NodeNext --moduleResolution NodeNext --target ES2023 --strict --esModuleInterop --skipLibCheck src/main.ts
USER node
CMD ["node", "dist/src/main.js"]
