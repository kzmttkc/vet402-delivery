import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SERVER_VERSION } from "../src/mcp.js";

test("the MCP server reports the package's own version (npm @vet402/check)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(SERVER_VERSION, pkg.version);
});
