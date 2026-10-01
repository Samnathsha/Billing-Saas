import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the project root so a stray lockfile in a parent folder is ignored.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
