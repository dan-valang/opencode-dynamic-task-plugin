/**
 * Clean entry point for OpenCode plugin loading.
 * Only re-exports the default plugin function — no named exports.
 * OpenCode's plugin loader rejects files with mixed default + named exports.
 * Tests use dist/index.js (which has the full module with named exports).
 */
export { default } from "./index.js";
