### ---------- build stage ----------
FROM node:20-bookworm-slim AS build

ENV DEBIAN_FRONTEND=noninteractive
ENV CI=true
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/providers/package.json ./packages/providers/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build \
  && pnpm prune --prod

### ---------- runtime stage ----------
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates espeak-ng fontconfig fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY --from=build /app ./

RUN mkdir -p /app/node_modules/@aivideo /app/node_modules/@hono \
  && ln -sfn /app/packages/core /app/node_modules/@aivideo/core \
  && ln -sfn /app/packages/providers /app/node_modules/@aivideo/providers \
  && ln -sfn /app/packages/shared /app/node_modules/@aivideo/shared \
  && YAML_DIR="$(find /app/node_modules/.pnpm -maxdepth 1 -type d -name 'yaml@*' | head -n 1)" \
  && test -n "$YAML_DIR" \
  && ln -sfn "$YAML_DIR/node_modules/yaml" /app/node_modules/yaml \
  && HONO_DIR="$(find /app/node_modules/.pnpm -maxdepth 1 -type d -name 'hono@*' | head -n 1)" \
  && test -n "$HONO_DIR" \
  && ln -sfn "$HONO_DIR/node_modules/hono" /app/node_modules/hono \
  && NODE_SERVER_DIR="$(find /app/node_modules/.pnpm -maxdepth 1 -type d -name '@hono+node-server@*' | head -n 1)" \
  && test -n "$NODE_SERVER_DIR" \
  && ln -sfn "$NODE_SERVER_DIR/node_modules/@hono/node-server" /app/node_modules/@hono/node-server

RUN mkdir -p /app/project

ENTRYPOINT ["node", "apps/cli/dist/index.js"]
CMD ["help"]
