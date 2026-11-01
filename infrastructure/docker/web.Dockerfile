# syntax=docker/dockerfile:1.7
# ResearchMate web (Next.js standalone build)

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ packages/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @researchmate/web...

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN pnpm --filter @researchmate/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd --system --gid 1001 researchmate && useradd --system --uid 1001 --gid researchmate researchmate \
  && apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=researchmate:researchmate /repo/apps/web/.next/standalone ./
COPY --from=build --chown=researchmate:researchmate /repo/apps/web/.next/static ./apps/web/.next/static
# Pre-create the storage mount point so a new named volume inherits this ownership.
RUN mkdir -p /var/lib/researchmate && chown researchmate:researchmate /var/lib/researchmate
USER researchmate
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fs http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "apps/web/server.js"]
