/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  /* N3 — import only the icons a page actually uses, not the whole icon set,
     so every page ships less JavaScript and opens faster on a phone. */
  experimental: { optimizePackageImports: ["lucide-react"] },
};
export default nextConfig;
