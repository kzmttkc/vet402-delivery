/**
 * The npm package @vet402/check (packages/check/package.json), as `npm pack` would ship it: built by
 * scripts/build.mjs, only dist/, README.md, LICENSE and package.json in the tarball, nothing secret-shaped
 * in them, and the built CLI and module running from a folder outside this repository (so the bundle does
 * not reach back into src/) with the same answer as the source CLI.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const PKG = join(import.meta.dirname, "..");
const ROOT = join(PKG, "..", "..");
const FX = join(import.meta.dirname, "fixtures");
const XONA = "https://api.xona-agent.com/token/pumpfun-trending";
const NEG = "obs_2026-09-28_000164";
const FIXTURE_ENV = { VET402_CHECK_RANK: join(FX, "rank.json"), VET402_CHECK_RECORDS_INDEX: join(FX, "records-index.json"), VET402_CHECK_RECORDS_BASE: join(FX, "records"), VET402_CHECK_LANES: "", VET402_CHECK_NOTIFIED: "" };

execFileSync(process.execPath, [join(PKG, "scripts", "build.mjs")], { stdio: "pipe" });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: PKG, encoding: "utf8" })) as { name: string; version: string; files: { path: string }[] }[];
const files = packed[0]!.files.map((f) => f.path).sort();
const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as Record<string, any>;
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, any>;

test("package.json: a name of its own, bin, exports with types, files, and the repository's dependency versions", () => {
  assert.equal(pkg.name, "@vet402/check");
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.bin, { "vet402-check": "dist/cli.js" });
  assert.deepEqual(pkg.exports["."], { types: "./dist/types/packages/check/src/index.d.ts", default: "./dist/index.js" });
  assert.deepEqual(pkg.files, ["dist", "README.md", "LICENSE"]);
  assert.equal(pkg.license, "MIT");
  for (const [name, v] of Object.entries(pkg.dependencies as Record<string, string>)) assert.equal(v, rootPkg.dependencies[name], name);
  assert.ok(!pkg.dependencies.tsx, "runs on plain Node: no tsx");
  assert.equal(packed[0]!.name, "@vet402/check");
});

test("npm pack: only dist, README, LICENSE and package.json; no TypeScript source, tests, fixtures, keys or env files", () => {
  for (const f of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/cli.js", "dist/observation.schema.json", "dist/types/packages/check/src/index.d.ts"]) assert.ok(files.includes(f), `missing ${f}`);
  for (const f of files) {
    assert.ok(
      ["package.json", "README.md", "LICENSE", "dist/observation.schema.json"].includes(f) || /^dist\/(index|cli|chunk-[A-Z0-9]+)\.js$/.test(f) || /^dist\/types\/[\w/.-]+\.d\.ts$/.test(f),
      `not expected in the tarball: ${f}`,
    );
    assert.ok(!/(^|\/)(\.env|\.keys|test|fixtures|node_modules|scripts)(\/|$)/.test(f), f);
  }
  assert.ok(files.length < 80, `${files.length} files`);
});

test("npm pack: nothing secret-shaped in any file", () => {
  // Public 32-byte constants the bundle needs: ERC-20 Transfer and Tempo TransferWithMemo event topics.
  const PUBLIC_HEX = new Set(["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0"]);
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const base58Bytes = (s: string) => {
    let n = 0n;
    for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
    let len = 0;
    while (n > 0n) (n >>= 8n), len++;
    for (const c of s) if (c === "1") len++;
    else break;
    return len;
  };
  for (const f of files) {
    const text = readFileSync(join(PKG, f), "utf8");
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), `${f}: PEM key`);
    assert.ok(!/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/.test(text), `${f}: a 64-number key array`);
    assert.ok(!/\/(?:Users|home)\/[a-z]/.test(text), `${f}: a local home path`);
    assert.ok(!/(?:sk|pk)_(?:live|test)_[0-9A-Za-z]{10,}|xox[abp]-[0-9A-Za-z-]{10,}|gh[pousr]_[0-9A-Za-z]{30,}|AKIA[0-9A-Z]{16}|eyJ[0-9A-Za-z_-]{10,}\.eyJ/.test(text), `${f}: a token shape`);
    for (const m of text.matchAll(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)) assert.ok(PUBLIC_HEX.has(m[0].toLowerCase()), `${f}: 32 bytes of hex not on the public list`);
    for (const m of text.matchAll(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{80,90}(?![1-9A-HJ-NP-Za-km-z])/g)) assert.notEqual(base58Bytes(m[0]), 64, `${f}: 64 bytes of base58 (a Solana secret key or signature)`);
  }
});

test("built package: runs outside the repository, the CLI gives the source CLI's answer byte for byte, and verifies a record", () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-check-pkg-"));
  try {
    const app = join(dir, "node_modules", "@vet402", "check");
    for (const f of files) cpSync(join(PKG, f), join(app, f));
    // npm packages from this repository's install (the versions package.json pins); no source file of the repository.
    symlinkSync(join(ROOT, "node_modules"), join(app, "node_modules"), "dir");
    const env = { ...process.env, ...FIXTURE_ENV };
    const built = spawnSync(process.execPath, [join(app, "dist", "cli.js"), XONA, "--json"], { cwd: dir, env, encoding: "utf8" });
    const source = spawnSync(process.execPath, [join(PKG, "bin", "vet402-check.mjs"), XONA, "--json"], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    assert.equal(source.status, 0, source.stderr);
    assert.equal(built.stdout, source.stdout);
    assert.ok(built.stdout.includes('"api.xona-agent.com"'));
    assert.ok(readFileSync(join(app, "dist", "cli.js"), "utf8").startsWith("#!/usr/bin/env node\n"), "bin has a shebang");
    const v = spawnSync(process.execPath, [join(app, "dist", "cli.js"), "verify", NEG, "--offline"], { cwd: dir, env, encoding: "utf8" });
    assert.equal(v.status, 0, v.stderr + v.stdout);
    const usage = spawnSync(process.execPath, [join(app, "dist", "cli.js")], { cwd: dir, env, encoding: "utf8" });
    assert.match(usage.stdout + usage.stderr, /usage:\n {2}vet402-check <url>/);
    // The module: import by package name from a file in the temp folder.
    const probe = join(dir, "probe.mjs");
    writeFileSync(probe, `import * as m from "@vet402/check";\nconsole.log(JSON.stringify(Object.keys(m).sort()));\n`);
    const keys = JSON.parse(execFileSync(process.execPath, [probe], { cwd: dir, encoding: "utf8" })) as string[];
    for (const k of ["wrapFetchWithCheck", "checkBeforePaying", "verifyRecord", "verdictFor", "PublicData", "CheckBlockedError", "serveStdio"]) assert.ok(keys.includes(k), k);
    // The declarations: a TypeScript user without skipLibCheck gets the types and no error.
    writeFileSync(join(dir, "package.json"), `{"type":"module"}\n`);
    writeFileSync(
      join(dir, "consumer.ts"),
      `import { wrapFetchWithCheck, checkBeforePaying, PublicData, type CheckResult } from "@vet402/check";\nexport const f = wrapFetchWithCheck(fetch, { block: "avoid" });\nexport const r: Promise<CheckResult> = checkBeforePaying({ url: "https://x.example/" }, new PublicData());\n// @ts-expect-error block takes only "avoid"\nwrapFetchWithCheck(fetch, { block: "pay" });\n`,
    );
    const tsconfig = { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: ["node"], typeRoots: [join(ROOT, "node_modules", "@types")] }, files: ["consumer.ts"] };
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
    const tsc = spawnSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", dir], { cwd: dir, encoding: "utf8" });
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
