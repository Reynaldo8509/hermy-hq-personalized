import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel-compatible settings
  output: undefined, // default — Vercel handles this automatically
  images: {
    unoptimized: false,
  },
  // The Raspberry Pi build worker cannot hold the full repository type graph
  // in memory; CI/Vercel remains responsible for strict TypeScript checking.
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
