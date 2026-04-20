FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

# Copy package.json and prisma schema
COPY package.json ./
COPY prisma/ ./prisma/

# Install deps (dev deps needed for tsc during build)
RUN npm install --legacy-peer-deps

# Generate Prisma client
RUN npx prisma generate --schema=./prisma/schema.prisma

# Copy all worker source
COPY . .

# Compile TypeScript to JS. Running compiled JS uses ~40-50% less RAM
# than ts-node at runtime (no in-memory transpiler, no per-import overhead),
# which fixes the SIGTERM/OOM pattern we hit on Render.
RUN npm run build

# tsc (with resolveJsonModule) does not copy JSON files to outDir, so we
# manually stage the DAC geo map alongside the compiled JS.
RUN mkdir -p dist/dac && cp src/dac/dac-geo-map.json dist/dac/dac-geo-map.json

# Playwright browsers already in base image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

# Run the compiled JS
CMD ["node", "dist/index.js"]
