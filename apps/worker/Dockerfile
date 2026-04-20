FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

# Copy package.json and prisma schema
COPY package.json ./
COPY prisma/ ./prisma/

# Install ALL deps (prod + dev) — tsc lives in devDependencies and we need it
# for the build step below. --include=dev forces dev deps even if the base
# image sets NODE_ENV=production (which would otherwise silently skip them
# and break `npm run build`).
RUN npm install --legacy-peer-deps --include=dev

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

# Cap Node's V8 heap so a leak surfaces as a clean out-of-memory error from
# the runtime (which we log + recover from) instead of Render's SIGTERM. On
# Render Standard (2 GB), 768 MB for Node + ~400 MB for Chromium leaves ~800
# MB of headroom for buffers, kernel, and spikes.
ENV NODE_OPTIONS="--max-old-space-size=768"

# Run the compiled JS
CMD ["node", "dist/index.js"]
