/**
 * Build the npm package vet402-check into packages/check/dist, so it runs on plain Node (no tsx):
 *
 *   dist/index.js, dist/cli.js (+ one shared chunk)  esbuild, ESM, node22. The repository code the check reads
 *                                                    (packages/check/src and the parts of src/ it imports) is
 *                                                    bundled; npm packages stay imports and are the package's
 *                                                    dependencies.
 *   dist/observation.schema.json                      read next to the bundle by src/receipt/schema.ts
 *   dist/types/                                       declarations from tsc (tsconfig.build.json); those of
 *                                                    src/ without their comments
 *
 * Fails unless package.json's dependencies are exactly the npm packages dist imports (the bundle, and the
 * declarations), each at the repository's version (the versions the tests ran on).
 *
 *   node packages/check/scripts/build.mjs        (npm pack and npm publish run it as prepack)
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(PKG, "..", "..");
const DIST = join(PKG, "dist");
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");

const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

rmSync(DIST, { recursive: true, force: true });

const result = await esbuild.build({
  absWorkingDir: ROOT,
  entryPoints: { index: "packages/check/src/index.ts", cli: "packages/check/src/bin.ts" },
  outdir: DIST,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  chunkNames: "chunk-[hash]",
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

copyFileSync(join(ROOT, "src", "receipt", "observation.schema.json"), join(DIST, "observation.schema.json"));

execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", join(PKG, "tsconfig.build.json")], { stdio: "inherit" });

// Declarations of the repository's src/ (reached through types the package exports) keep their code but
// lose their comments: those were written for the repository, the package's own (packages/check/src) stay.
for (const file of readdirSync(join(DIST, "types", "src"), { recursive: true })) {
  if (!String(file).endsWith(".d.ts")) continue;
  const path = join(DIST, "types", "src", String(file));
  const text = readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*\n/gm, "")
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
  writeFileSync(path, text);
}

// The npm packages the build needs: imported by the bundle, or named in a declaration (a TypeScript user
// without skipLibCheck needs those too). Exactly these are the package's dependencies.
const root = (path) => (path.startsWith("@") ? path.split("/").slice(0, 2).join("/") : path.split("/")[0]);
const needed = new Map();
for (const out of Object.values(result.metafile.outputs))
  for (const i of out.imports) if (i.external && !i.path.startsWith("node:")) needed.set(root(i.path), "the bundle");
for (const file of readdirSync(join(DIST, "types"), { recursive: true })) {
  if (!String(file).endsWith(".d.ts")) continue;
  const text = readFileSync(join(DIST, "types", String(file)), "utf8");
  for (const m of text.matchAll(/(?:from |import\()"([^".][^"]*)"/g)) if (!m[1].startsWith("node:")) needed.set(root(m[1]), needed.get(root(m[1])) ?? "a declaration");
}
const declared = pkg.dependencies ?? {};
const problems = [];
for (const [name, by] of needed) {
  if (!declared[name]) problems.push(`${name} is imported by ${by} but not in packages/check/package.json dependencies`);
  else if (declared[name] !== rootPkg.dependencies?.[name]) problems.push(`${name}: ${declared[name]} here, ${rootPkg.dependencies?.[name]} in the repository's package.json`);
}
for (const name of Object.keys(declared)) if (!needed.has(name)) problems.push(`${name} is a dependency nothing in dist imports`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(`built ${DIST} (dependencies: ${[...needed.keys()].sort().join(", ")})`);
