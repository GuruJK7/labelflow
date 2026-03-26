/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@labelflow/shared'],
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'bullmq', 'ioredis'],
  },
};

module.exports = nextConfig;
