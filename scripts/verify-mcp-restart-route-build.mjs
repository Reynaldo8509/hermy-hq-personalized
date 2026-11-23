import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const distDir = process.env.NEXT_DIST_DIR || ".next";
const serverDir = path.join(root, distDir, "server");
const manifestPath = path.join(serverDir, "app-paths-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const route = "/api/mcp/restart-requests/[id]/route";
const expectedHandler = "app/api/mcp/restart-requests/[id]/route.js";

assert.equal(manifest[route], expectedHandler, "dynamic request-status route is missing or mapped unexpectedly");
const handlerPath = path.join(serverDir, manifest[route]);
assert.ok(statSync(handlerPath).isFile(), "compiled dynamic route handler is missing");
const compiled = readFileSync(handlerPath, "utf8");
// Next's production bundler minifies imported function names; verify stable contract
// markers from the emitted handler instead of source-level identifiers.
assert.match(compiled, /GET/, "compiled dynamic handler does not export GET");
assert.match(compiled, /x-mcp-restart-token/, "compiled handler lost its dedicated credential input");
assert.match(compiled, /requested_by/, "compiled handler lost the principal ownership filter");
assert.match(compiled, /mcp_restart_v2/, "compiled handler lost the approval contract filter");
assert.match(compiled, /CANCELLED/, "compiled handler lost the public status contract");
console.log("mcp_restart_dynamic_route_manifest=PASS compiled_handler=PASS auth_input=PASS owner_filter=PASS status_contract=PASS");
