const controlApiUrl = (process.env.NODE_CONTROL_API_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");

/** Keep browser requests same-origin while forwarding API and SSE traffic. */
const nextConfig = {
  compress: false,
  allowedDevOrigins: ["192.168.1.181", "192.168.1.0/24", "localhost", "127.0.0.1"],
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${controlApiUrl}/:path*` },
      { source: "/projects/:path*", destination: `${controlApiUrl}/projects/:path*` },
      { source: "/agents/:path*", destination: `${controlApiUrl}/agents/:path*` },
      { source: "/tasks/:path*", destination: `${controlApiUrl}/tasks/:path*` },
      { source: "/sessions/:path*", destination: `${controlApiUrl}/sessions/:path*` },
    ];
  },
};

export default nextConfig;
