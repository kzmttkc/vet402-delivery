/**
 * Clear up proxy-buy purchases the reconciler reported (ALERT) and could not close by itself (src/proxy-buy/resolve.ts).
 * Every change writes its reason to the record and the alert.
 *
 *   npm run proxy-buy:resolve -- list                                   open alerts and the purchases behind them
 *   npm run proxy-buy:resolve -- recheck <id>                           look again now (one reconcile run)
 *   npm run proxy-buy:resolve -- reopen-refund <id> --reason "..." [--to <address>]
 *                                                                       a stuck refund may be sent again
 *   npm run proxy-buy:resolve -- settle <id> --reason "..." --spent <atomic> [--refund-tx <signature or hash>]
 *                                                                       close it with what a person found out
 *   npm run proxy-buy:resolve -- note <id> --reason "..."               a reason on its alerts, nothing else
 *
 * Needs DATABASE_URL; recheck also needs the server's environment (RPCs, payer keys), as the reconciler does.
 */
import { join } from "node:path";
import { configFromEnv } from "../src/proxy-buy/config.js";
import { migrate } from "../src/proxy-buy/db.js";
import { DEFAULT_STALE_MS } from "../src/proxy-buy/handler.js";
import { reconcile } from "../src/proxy-buy/reconcile.js";
import { redact } from "../src/proxy-buy/reasons.js";
import { note, recheck, reopenRefund, settleByHand } from "../src/proxy-buy/resolve.js";
import { Store } from "../src/proxy-buy/store.js";
import { buildProxyBuy, dayCaps, openDatabase } from "../src/proxy-buy/wire.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, id, ...rest] = process.argv.slice(2);
  const cfg = configFromEnv(process.env);
  if (!cfg.databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = openDatabase(cfg.databaseUrl);
  await migrate(sql);
  const store = new Store(sql);
  const reason = flag(rest, "--reason");
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new Error(`${what} is required`);
    return v;
  };
  switch (cmd) {
    case "list": {
      const alerts = await store.openAlerts(500);
      const ids = [...new Set(alerts.map((a) => a.purchase_id))].filter((x) => !x.startsWith("wallet:"));
      const rows = await Promise.all(ids.map(async (x) => ({ id: x, row: await store.get(x), refund: await store.getRefund(x) })));
      console.log(
        JSON.stringify(
          {
            alerts,
            purchases: rows.map((r) => ({ id: r.id, state: r.row?.state ?? null, chain: r.row?.chain ?? null, total: r.row?.total ?? null, fees: (r.row?.facts as { fees?: unknown } | undefined)?.fees ?? null, refund: r.refund ? { status: r.refund.status, attempt: r.refund.attempt, failures: r.refund.failures, tx: r.refund.tx, to: r.refund.to_addr } : null })),
          },
          null,
          2,
        ),
      );
      break;
    }
    case "recheck": {
      need(id, "<id>");
      if (!(await recheck(store, id!))) throw new Error("no open purchase with this id");
      const built = await buildProxyBuy(cfg, { dataDir: join(import.meta.dirname, "..", "data"), sql });
      const caps = dayCaps(cfg, "solana") ?? dayCaps(cfg, "tempo");
      if (!caps) throw new Error("neither Solana nor Tempo is configured");
      const actions = await reconcile({
        store: built.store,
        feeAtomic: cfg.feeAtomic,
        now: () => new Date(),
        recordUrl: (x) => `${cfg.publicOrigin}/v1/buy/records/${x}`,
        caps,
        maxRefund: cfg.maxPerCallAtomic + cfg.feeAtomic,
        deadline: Date.now() + 5 * 60_000,
        staleMs: DEFAULT_STALE_MS,
        walletCheck: false,
        ...(built.solana ? { solana: built.solana } : {}),
        ...(built.tempo ? { tempo: built.tempo } : {}),
      });
      console.log(JSON.stringify(actions.filter((a) => a.id === id), null, 2));
      break;
    }
    case "reopen-refund": {
      const to = flag(rest, "--to");
      const r = await reopenRefund(store, need(id, "<id>"), { reason: need(reason, "--reason"), ...(to ? { to } : {}), now: new Date() });
      console.log(JSON.stringify(r));
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case "settle": {
      const spent = need(flag(rest, "--spent"), "--spent (atomic units that left the payer for this purchase)");
      if (!/^\d+$/.test(spent)) throw new Error("--spent: atomic units, digits only");
      const refundTx = flag(rest, "--refund-tx");
      const r = await settleByHand(store, need(id, "<id>"), { reason: need(reason, "--reason"), spent: BigInt(spent), ...(refundTx ? { refundTx } : {}), now: new Date() });
      console.log(JSON.stringify(r));
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case "note":
      await note(store, need(id, "<id>"), need(reason, "--reason"));
      console.log(JSON.stringify({ ok: true }));
      break;
    default:
      throw new Error("usage: proxy-buy:resolve -- list | recheck <id> | reopen-refund <id> --reason .. [--to ..] | settle <id> --reason .. --spent .. [--refund-tx ..] | note <id> --reason ..");
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(`proxy buy resolve: ${redact(String((e as Error).message ?? e), 300)}`);
  process.exit(1);
});
