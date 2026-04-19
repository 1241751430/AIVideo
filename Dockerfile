### ---------- build stage ----------
FROM node:20-bookworm-slim AS build

ENV DEBIAN_FRONTEND=noninteractive
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
  && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/cli/package.json /app/apps/cli/dist ./apps/cli/dist/
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/providers/package.json ./packages/providers/package.json
COPY --from=build /app/packages/providers/dist ./packages/providers/dist
COPY --from=build /app/apps/cli/node_modules ./apps/cli/node_modules
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/providers/node_modules ./packages/providers/node_modules
COPY workers ./workers
COPY aivideo.config.yaml .env.example ./

RUN groupadd --system aivideo && useradd --system --gid aivideo aivideo \
  && mkdir -p /app/projects && chown -R aivideo:aivideo /app/projects
USER aivideo

ENTRYPOINT ["node", "apps/cli/dist/index.js"]
CMD ["help"]
