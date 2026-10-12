FROM node:22-alpine

WORKDIR /app

# Install curl for healthcheck
RUN apk add --no-cache curl

# Install dependencies reproducibly using lockfile
COPY package.json package-lock.json ./
RUN npm ci

# Copy application source and scripts
COPY src/ ./src/
COPY scripts/ ./scripts/

# Ensure snapshots directory exists
RUN mkdir -p /app/snapshots

# Application environment configuration
ENV PORT=3000
ENV NODE_ENV=production

# Expose application port
EXPOSE 3000

# Healthcheck calling /_debug/metrics, healthy within 30s
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/_debug/metrics || exit 1

# Execute the required npm start script (node --expose-gc src/index.js)
CMD ["npm", "start"]
