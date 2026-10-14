// Next.js config with control API proxy rewrites.
const proxyTimeoutMs = Number(process.env.NODE_CONTROL_API_PROXY_TIMEOUT_MS ?? Number(process.env.NODE_SDK_AGENT_TIMEOUT_MS ?? 3600000) + 60000);
if (!Number.isSafeInteger(proxyTimeoutMs) || proxyTimeoutMs <= 0) throw new Error("NODE_CONTROL_API_PROXY_TIMEOUT_MS must be a positive integer in milliseconds.");

/** Keep browser requests same-origin while forwarding API and SSE traffic. */
const nextConfig = {
  compress: false,
  logging: { incomingRequests: false },
  experimental: { proxyTimeout: proxyTimeoutMs },
  allowedDevOrigins: ["192.168.1.181", "192.168.1.0/24", "localhost", "127.0.0.1"],
  async rewrites() {
    return { afterFiles: [
      { source: "/api/:path*", destination: "/control-api/:path*" },
      { source: "/forge/v1/:path*", destination: "/control-api/forge/v1/:path*" },
      { source: "/projects/:path*", destination: "/control-api/projects/:path*" },
      { source: "/tasks/:path*", destination: "/control-api/tasks/:path*" },
      { source: "/sessions/:path*", destination: "/control-api/sessions/:path*" },
    ] };
  },
};

export default nextConfig;
