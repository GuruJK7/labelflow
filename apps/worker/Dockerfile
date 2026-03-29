FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

# Copy package.json and prisma schema
COPY package.json ./
COPY prisma/ ./prisma/

# Install deps
RUN npm install --legacy-peer-deps

# Generate Prisma client
RUN npx prisma generate --schema=./prisma/schema.prisma

# Copy all worker source
COPY . .

# Playwright browsers already in base image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

# Run directly with ts-node (skip tsc build to avoid stale dist issues)
CMD ["npx", "ts-node", "--skipProject", "--transpile-only", "src/index.ts"]
