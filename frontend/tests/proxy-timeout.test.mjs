// Guard the rewrite proxy's timeout.
//
// Next's rewrite proxy aborts a request after 30 seconds by default and returns
// its own 500 — the backend never sees the request at all, so there is nothing
// in the backend logs to explain the failure. A real answer over the local
// model takes around two minutes, so without this the product's primary
// feature fails through the proxy that the Docker stack uses.
//
// This test reads next.config.js and checks the timeout is set high enough to
// outlast the backend's own Ollama timeout.

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const config = require("../next.config.js");

// The backend gives Ollama 300 seconds (OLLAMA_TIMEOUT_SEC).
const BACKEND_OLLAMA_TIMEOUT_MS = 300_000;

assert.ok(
  typeof config.experimental?.proxyTimeout === "number",
  "next.config.js must set experimental.proxyTimeout — the 30s default " +
    "aborts real answers",
);

assert.ok(
  config.experimental.proxyTimeout > BACKEND_OLLAMA_TIMEOUT_MS,
  `proxyTimeout (${config.experimental.proxyTimeout}ms) must outlast the ` +
    `backend's Ollama timeout (${BACKEND_OLLAMA_TIMEOUT_MS}ms), or the proxy ` +
    `is still the thing that gives up first`,
);

// The rewrite itself must still point at the backend.
const rewrites = await config.rewrites();
assert.ok(Array.isArray(rewrites) && rewrites.length > 0, "expected a rewrite");
const [rewrite] = rewrites;
assert.equal(rewrite.source, "/api/v1/:path*");
assert.ok(
  rewrite.destination.includes("/api/v1/:path*"),
  "the rewrite must forward the API path to the backend",
);

console.log("proxy timeout configuration is correct");
