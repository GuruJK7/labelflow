/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'bullmq', 'ioredis'],
  },
};

module.exports = nextConfig;
