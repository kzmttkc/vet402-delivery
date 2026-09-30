/**
 * node:http adapter for the proxy buy handler (one long-running process; see books.ts for why one).
 * An unexpected error answers 500 with a fixed message: no stack, no config, no key material.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ProxyBuy } from "./handler.js";

/** Largest request body read (the handler serves GET only; this bounds what a client can make vet402 buffer). */
const MAX_REQUEST_BYTES = 16 * 1024;

export function toRequest(req: IncomingMessage, origin: string, trustProxy = false): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  // The rate limit keys on x-real-ip. Only a reverse proxy vet402 runs may set it; otherwise a client
  // could pick its own key, so it is replaced by the socket address.
  if (!trustProxy) {
    headers.delete("x-forwarded-for");
    headers.set("x-real-ip", req.socket.remoteAddress ?? "unknown");
  }
  return new Request(new URL(req.url ?? "/", origin), { method: req.method ?? "GET", headers });
}

export async function writeResponse(res: ServerResponse, r: Response): Promise<void> {
  const h: Record<string, string> = {};
  r.headers.forEach((v, k) => (h[k] = v));
  res.writeHead(r.status, h);
  res.end(Buffer.from(await r.arrayBuffer()));
}

export function listener(buy: ProxyBuy, origin: string, onError: (e: unknown) => void = () => undefined, trustProxy = false) {
  return (req: IncomingMessage, res: ServerResponse) => {
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_REQUEST_BYTES) req.destroy();
    });
    buy
      .handle(toRequest(req, origin, trustProxy))
      .then((r) => writeResponse(res, r))
      .catch((e) => {
        onError(e);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      });
  };
}

export function startServer(buy: ProxyBuy, o: { port: number; host?: string; origin: string; onError?: (e: unknown) => void; trustProxy?: boolean }): Promise<Server> {
  const s = createServer(listener(buy, o.origin, o.onError, o.trustProxy ?? false));
  return new Promise((resolve, reject) => {
    s.once("error", reject);
    s.listen(o.port, o.host ?? "127.0.0.1", () => resolve(s));
  });
}
