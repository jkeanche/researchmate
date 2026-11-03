# syntax=docker/dockerfile:1.7
# ResearchMate background worker, migrations and admin CLI.
# The same image runs `migrate` (one-off) and the long-lived worker.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ packages/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter @researchmate/worker... --filter @researchmate/database...

FROM base AS runtime
ENV NODE_ENV=production
# Text extraction: poppler (PDF → image) and Tesseract (OCR for scanned PDFs).
# Document rendering: LibreOffice Writer with Python-UNO (updates the table of
# contents before PDF export) and fonts metric-compatible with Times New Roman,
# Arial and Calibri/Cambria, so pagination matches the specification.
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils tesseract-ocr tesseract-ocr-eng \
      libreoffice-writer-nogui python3-uno \
      fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
ENV HOME=/tmp
RUN groupadd --system --gid 1001 researchmate && useradd --system --uid 1001 --gid researchmate researchmate
COPY --from=deps --chown=researchmate:researchmate /repo /repo
COPY --chown=researchmate:researchmate tsconfig.base.json ./
COPY --chown=researchmate:researchmate apps/worker apps/worker
COPY --chown=researchmate:researchmate packages packages
# Pre-create the storage mount point so a new named volume inherits this ownership.
RUN mkdir -p /var/lib/researchmate && chown researchmate:researchmate /var/lib/researchmate
USER researchmate
WORKDIR /repo/apps/worker
# Healthy while the process refreshes its heartbeat file (every 30 s).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD test -f /tmp/researchmate-heartbeat && test $(( $(date +%s) - $(stat -c %Y /tmp/researchmate-heartbeat) )) -lt 120 || exit 1
# tsx runs the TypeScript sources directly (workspace packages export .ts).
CMD ["node", "--import", "tsx", "src/index.ts"]
