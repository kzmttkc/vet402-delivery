#!/usr/bin/env node
/**
 * The command of the npm package (`npx vet402-check <url>`), built to dist/cli.js by scripts/build.mjs.
 * From a clone, bin/vet402-check.mjs runs cli.ts through tsx instead.
 */
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2));
