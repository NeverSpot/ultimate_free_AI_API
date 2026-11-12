# syntax=docker/dockerfile:1.7

# ============ Stage 1: builder ============
FROM node:24-alpine AS builder
WORKDIR /app

# Install dependency manifests first — maximizes layer caching
COPY package*.json ./
COPY tsconfig*.json ./

# BuildKit cache mount for npm — persists ~/.npm across builds
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy source and build
COPY . .
RUN npm run build

# Drop devDependencies before crossing to runtime stage
RUN npm prune --omit=dev

# ============ Stage 2: runtime ============
FROM node:24-alpine AS runtime
WORKDIR /app

# tini = proper PID 1 signal handling (SIGTERM reaches Node)
RUN apk add --no-cache tini

# Use built-in non-root user (UID 1000) from official node image
USER node

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    PORT=8080

# Copy only production artifacts with correct ownership
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist         ./dist
COPY --from=builder --chown=node:node /app/package.json ./

EXPOSE 8080

# Healthcheck — orchestrators detect dead app, not just dead container
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
