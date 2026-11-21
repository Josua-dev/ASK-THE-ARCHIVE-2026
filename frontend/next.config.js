/** @type {import('next').NextConfig} */

// The rewrite proxy aborts a request after 30 seconds by default, and the
// failure is silent: the proxy returns its own 500 and the backend never
// sees the request at all, so there is nothing in the backend logs to explain
// it. A real answer over the local model takes around two minutes, so every
// question through the proxy failed.
//
// Next reads this from `experimental.proxyTimeout` — a top-level key is
// ignored, and the default is 30000ms. It has to outlast the backend's own
// Ollama timeout (300s by default), or the proxy is still the thing that
// gives up first.
const PROXY_TIMEOUT_MS = 600_000;

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    proxyTimeout: PROXY_TIMEOUT_MS,
  },
  async rewrites() {
    const target = process.env.API_PROXY_TARGET || "http://127.0.0.1:8000";
    return [
      {
        source: "/api/v1/:path*",
        destination: `${target}/api/v1/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
