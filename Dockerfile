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
COPY packages/core/package.json ./packages/core/package.json
COPY packages/providers/package.json ./packages/providers/package.json

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
  && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates espeak-ng \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY --from=build /app ./

RUN mkdir -p /app/node_modules/@aivideo \
  && ln -sfn /app/packages/core /app/node_modules/@aivideo/core \
  && ln -sfn /app/packages/providers /app/node_modules/@aivideo/providers \
  && YAML_DIR="$(find /app/node_modules/.pnpm -maxdepth 1 -type d -name 'yaml@*' | head -n 1)" \
  && test -n "$YAML_DIR" \
  && ln -sfn "$YAML_DIR/node_modules/yaml" /app/node_modules/yaml

RUN groupadd --system aivideo && useradd --system --gid aivideo aivideo \
  && mkdir -p /app/projects && chown -R aivideo:aivideo /app/projects
USER aivideo

ENTRYPOINT ["node", "apps/cli/dist/index.js"]
CMD ["help"]
