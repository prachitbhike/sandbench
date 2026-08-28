/** @type {import('next').NextConfig} */
const nextConfig = {
  // @sgp/core is a workspace TS package compiled to dist/; nothing to transpile,
  // but it does touch the filesystem, so keep it server-only.
  serverExternalPackages: [],
  experimental: { optimizePackageImports: [] },
};
export default nextConfig;
