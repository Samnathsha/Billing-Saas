# The app as a container (Phase 12; decision 0007), for any host that runs
# containers (Fly.io, Render...). Holds NO settings or secrets: the host
# provides them as environment variables at run time (docs/deploy.md).
#   docker build -t billing .
#   docker run -p 3000:3000 --env-file <host settings> billing

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Linux builds of the native parts (password hashing, image resizing) come
# from the lockfile's platform packages.
RUN npm ci --no-audit --no-fund

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Public (not secret): the browser's error-report address, fixed at build.
ARG NEXT_PUBLIC_SENTRY_DSN=""
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
RUN npm run build

FROM node:24-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# Only the self-contained server, its static files and public files; runs as
# the unprivileged "node" user.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
