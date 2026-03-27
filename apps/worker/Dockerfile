FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Copy only the worker's package.json first for caching
COPY apps/worker/package.json ./package.json

# Copy prisma schema (needed for prisma generate)
COPY apps/web/prisma/ ./prisma/

# Install deps
RUN npm install --legacy-peer-deps

# Generate Prisma client
RUN npx prisma generate --schema=./prisma/schema.prisma

# Copy worker source
COPY apps/worker/ ./

# Build TypeScript
RUN npx tsc || true

# Playwright browsers already in base image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
