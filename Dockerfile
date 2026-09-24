# syntax=docker/dockerfile:1
#
# Hosted mode (`bugsecure-mcp serve --http`): Streamable HTTP MCP server acting
# as an OAuth 2.1 protected resource. Multi-stage; the runtime image is
# distroless (no shell, no package manager) and runs as an unprivileged user.
#
#   docker build -t bugsecure-mcp .
#   docker run --rm -p 8944:8944 \
#     -e BUGSECURE_MCP_RESOURCE=https://mcp.example.com/mcp \
#     -e BUGSECURE_CLIENT_SECRET_FILE=/run/secrets/bugsecure_client_secret \
#     --mount type=bind,src=./secret,dst=/run/secrets/bugsecure_client_secret,readonly \
#     bugsecure-mcp
#
# Base images are pinned by digest; Dependabot keeps them current.

FROM node:26.8.2-trixie-slim@sha256:f7bb8247fdb16250dbec7fd0e24f091c6f5f0a29d256f3aef5816a7a369166b2 AS base
WORKDIR /app
ENV CI=true
# pnpm version comes from package.json#packageManager.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# --ignore-scripts: dependencies may not run install scripts anyway
# (pnpm-workspace.yaml), and our own `prepare` only installs git hooks.
FROM base AS build
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:bb6b03d81066993293a10feda7250e8e1cc034035fe9b61cfceededa7c8bf04d AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8944
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json LICENSE NOTICE ./
USER nonroot
EXPOSE 8944
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8944)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node", "dist/cli.js"]
CMD ["serve", "--http"]
