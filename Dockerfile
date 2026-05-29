# =============================================================
# Dockerfile — insurance-api
#
# Multi-stage build:
#   Stage 1 (deps)  : install ONLY production dependencies
#   Stage 2 (runner): copy app + prod deps into a minimal image
#
# This keeps the final image small (~180MB vs ~600MB for full node)
# and ensures devDependencies (jest, nodemon) never ship to prod.
# =============================================================

# ── Stage 1: Install production dependencies ──────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifests first — Docker layer-caches this step as long as
# package.json / package-lock.json haven't changed.
COPY package*.json ./

RUN npm ci --omit=dev              # --omit=dev skips devDependencies


# ── Stage 2: Final runtime image ──────────────────────────────
FROM node:20-alpine AS runner

# Security: run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app

# Copy prod deps from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src/ ./src/
COPY package.json ./

# Switch to non-root before starting
USER appuser

EXPOSE 3000

# Explicit JSON form prevents shell interpretation issues
CMD ["node", "src/server.js"]
