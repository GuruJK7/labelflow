FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Copy workspace root
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/worker/package.json ./apps/worker/

# Install deps
RUN npm install --workspace=apps/worker --workspace=packages/shared

# Copy source
COPY packages/shared/ ./packages/shared/
COPY apps/worker/ ./apps/worker/
COPY apps/web/prisma/ ./apps/web/prisma/

# Generate Prisma client
RUN npx prisma generate --schema=apps/web/prisma/schema.prisma

# Build worker
RUN npm run build --workspace=apps/worker

# Playwright browsers already in base image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

EXPOSE 3001

CMD ["node", "apps/worker/dist/index.js"]
