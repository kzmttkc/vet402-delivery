/**
 * The secret gate (src/daily/secret-gate.ts) from the shell. Prints file, path, kind, length and a masked
 * shape for each finding, never a value.
 *
 *   npx tsx scripts/daily/secret-gate.ts copy <result.json> <data copy> [--allow <file>] [--keys-dir <dir>]
 *       Writes the public copy (known shapes redacted) only when nothing else is found in it.
 *       stdout: one JSON line {"sha256": ..., "redactions": [...]}. Exit 3 when blocked (nothing written).
 *   npx tsx scripts/daily/secret-gate.ts scan <root> [<dir> ...] [--allow <file>] [--keys-dir <dir>]
 *       Every file under <root>/<dir> (default: data site). Exit 3 when any finding is not allowed.
 *   npx tsx scripts/daily/secret-gate.ts baseline <root> [<dir> ...] --reason <text> [--allow <file>]
 *       Prints allow entries for the findings the allow list lacks, for a person to read where they appear and
 *       add (each needs its own reason). Whole files are listed under "files" with their sha256.
 *       Known shapes (a seller token left in a body) are never printed as allowable.
 *
 * --allow defaults to scripts/daily/secret-allow.json. --keys-dir: the runner's key folder; any encoding
 * of those keys in a public file is a finding that no allow entry can cover.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOW_KIND,
  blockingFindings,
  describe,
  gateTree,
  loadAllowList,
  ownKeyNeedles,
  publicJson,
  redactKnown,
  scanFileText,
  sha256Hex,
  type ScanOptions,
} from "../../src/daily/secret-gate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (n: string): string | undefined => {
  const i = args.indexOf(n);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) usage(`${n} needs a value`);
  args.splice(i, 2);
  return v;
};
function usage(msg: string): never {
  console.error(`${msg}\nusage: secret-gate.ts copy <result.json> <out> | scan <root> [dirs] | baseline <root> [dirs] --reason <text>  [--allow file] [--keys-dir dir]`);
  process.exit(2);
}

const allowFile = resolve(opt("--allow") ?? join(HERE, "secret-allow.json"));
const keysDir = opt("--keys-dir");
const reason = opt("--reason");
const allow = existsSync(allowFile) ? loadAllowList(allowFile) : { allow: [], files: [] };
const scanOpts: ScanOptions = { ownKeys: keysDir ? ownKeyNeedles(resolve(keysDir)) : [] };

if (cmd === "copy") {
  const [src, out] = args;
  if (!src || !out) usage("copy needs <result.json> <out>");
  const { value, redactions } = redactKnown(JSON.parse(readFileSync(src, "utf8")));
  const text = publicJson(value);
  // Values from whole files the list allows (copies of other public sources) are accepted here as in the tree.
  const covered = new Set<string>();
  for (const f of allow.files) {
    const abs = join(process.cwd(), f.path);
    if (!existsSync(abs)) continue;
    const t = readFileSync(abs, "utf8");
    if (sha256Hex(t) !== f.sha256) continue;
    for (const x of scanFileText(t, f.path)) if (!x.known && x.kind !== "own-key") covered.add(`${x.kind}:${x.sha256}`);
  }
  const block = blockingFindings(scanFileText(text, basename(out), scanOpts), allow, covered);
  if (block.length) {
    for (const f of block) console.error(`blocked: ${describe(f)}`);
    console.error(`secret gate: ${block.length} finding(s) in the copy of ${basename(src)}; nothing written`);
    process.exit(3);
  }
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const tmp = `${resolve(out)}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, resolve(out));
  console.log(JSON.stringify({ sha256: sha256Hex(text), redactions }));
} else if (cmd === "scan" || cmd === "baseline") {
  const [root, ...dirs] = args;
  if (!root) usage(`${cmd} needs <root>`);
  const { files, findings, blocking: block } = gateTree(resolve(root), dirs.length ? dirs : ["data", "site"], allow, scanOpts);
  if (cmd === "scan") {
    for (const f of block) console.error(`blocked: ${describe(f)}`);
    console.log(`secret gate: ${files} files, ${findings.length} finding(s), ${block.length} not allowed`);
    process.exit(block.length ? 3 : 0);
  }
  if (!reason) usage("baseline needs --reason");
  const seen = new Set<string>();
  const entries = [];
  for (const f of block) {
    if (f.known || f.kind === "own-key") {
      console.error(`not allowable (redact it instead): ${describe(f)}`);
      continue;
    }
    const k = `${f.kind}:${f.sha256}`;
    if (seen.has(k)) continue;
    seen.add(k);
    entries.push({ sha256: f.sha256, kind: f.kind, reason: `${reason} First seen: ${f.file} ${f.path || "-"} (len ${f.length}, shape ${f.shape}).` });
  }
  console.log(JSON.stringify({ kind: ALLOW_KIND, allow: entries }, null, 2));
} else {
  usage("unknown command");
}
