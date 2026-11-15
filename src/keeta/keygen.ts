/**
 * Write a new Keeta payer key once. Never overwrites an existing key file.
 */
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeKeetaKey(opts: {
  dir: string;
  generateSeed: () => string;
  addressOf: (seed: string) => string;
}): string {
  if (existsSync(opts.dir)) {
    const dmode = statSync(opts.dir).mode & 0o777;
    if (dmode & 0o077) throw new Error(`key folder must be mode 700 or tighter (is ${dmode.toString(8)})`);
  } else {
    mkdirSync(opts.dir, { mode: 0o700 });
  }
  const json = join(opts.dir, "keeta-payer.json");
  const pub = join(opts.dir, "keeta-payer.pub");
  if (existsSync(json) || existsSync(pub)) throw new Error("a Keeta payer key already exists in this folder");
  const seed = opts.generateSeed();
  const address = opts.addressOf(seed);
  let fd: number;
  try {
    fd = openSync(json, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("keeta-payer.json already exists");
    throw e;
  }
  try {
    writeFileSync(fd, JSON.stringify({ seed, index: 0 }) + "\n");
  } finally {
    closeSync(fd);
  }
  let pfd: number;
  try {
    pfd = openSync(pub, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("keeta-payer.pub already exists");
    throw e;
  }
  try {
    writeFileSync(pfd, `${address}\n`);
  } finally {
    closeSync(pfd);
  }
  return address;
}