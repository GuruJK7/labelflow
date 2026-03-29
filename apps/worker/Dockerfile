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

# Clean dist and build TypeScript fresh
RUN rm -rf dist && npx tsc --skipLibCheck || true

# Playwright browsers already in base image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
