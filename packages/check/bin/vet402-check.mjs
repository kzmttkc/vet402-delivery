#!/usr/bin/env node
// Entry for `npx github:kzmttkc/vet402-delivery#main ...`: runs the TypeScript CLI through tsx.
import { tsImport } from "tsx/esm/api";

const { main } = await tsImport("../src/cli.ts", import.meta.url);
const code = await main(process.argv.slice(2));
process.exitCode = code;
