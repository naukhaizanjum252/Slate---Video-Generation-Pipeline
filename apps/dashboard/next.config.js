/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow importing the shared workspace package directly.
  transpilePackages: ['@slate/shared'],
};

module.exports = nextConfig;
