FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/cli/package.json ./apps/cli/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/providers/package.json ./packages/providers/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

ENTRYPOINT ["node", "apps/cli/dist/index.js"]
CMD ["help"]
