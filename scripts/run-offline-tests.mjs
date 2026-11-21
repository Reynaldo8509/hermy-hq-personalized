import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const roots = ["hermes-bridge", "src/lib"];
const tests = roots.flatMap((root) =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => path.join(root, entry.name))
).sort();

if (tests.length === 0) {
  console.error("No offline tests were found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
if (result.error) {
  console.error("Unable to start Node test runner:", result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
