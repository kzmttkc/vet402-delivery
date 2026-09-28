/**
 * RFC 8785 (JCS) canonical JSON for the values an observation holds: strings, booleans, null,
 * finite numbers, arrays and plain objects. Keys are sorted by UTF-16 code units (RFC 8785 §3.2.3),
 * numbers use the ECMAScript serialization (§3.2.2.3), which JSON.stringify already produces.
 * Anything else (undefined, NaN, Infinity, bigint, functions) is rejected rather than dropped.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("jcs: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error("jcs: not a plain object");
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        if (obj[k] === undefined) throw new Error(`jcs: undefined at key ${k}`);
        parts.push(`${JSON.stringify(k)}:${canonicalize(obj[k])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(`jcs: unsupported type ${typeof value}`);
  }
}
