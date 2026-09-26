/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  devIndicators: false,
  // Do not generate AGENTS.md / CLAUDE.md in the app directory on dev start.
  agentRules: false,
};

export default nextConfig;
