/**
 * The records part of the public site (site/records/), built from data/records/:
 *   records/index.html    every published record, grouped by seller
 *   records/<id>.html     the record page (html.ts), static: no script, same CSP as the ranking pages
 *   records/<id>.json     the signed record, byte for byte (written by scripts/build-site.ts)
 * Every value from a record goes through esc.
 */
import { esc, chainName, formatAmount, formatUtc, renderObservationPage, shortHash } from "./html.js";
import type { LoadedRecords } from "./publish.js";

/** Where GitHub Pages serves the site. */
export const PUBLIC_SITE_URL = "https://kzmttkc.github.io/vet402-delivery";
const PUBLIC_REPO_URL = "https://github.com/kzmttkc/vet402-delivery";
export const OBSERVER_KEYS_URL = `${PUBLIC_REPO_URL}/blob/main/src/receipt/observers.ts`;

const EXAMPLE_PLACEHOLDER = "obs_YYYY-MM-DD_NNNNNN";

export function verifyCommandFor(id: string): string {
  return `git clone ${PUBLIC_REPO_URL}\ncd vet402-delivery && npm ci\nnpx tsx scripts/verify-receipt.ts ${PUBLIC_SITE_URL}/records/${id}.json`;
}

export interface RecordLink {
  id: string;
  day: string;
  network: string;
}

/** Seller key -> that seller's published records, oldest first. For links from the ranking pages. */
export function recordsBySeller(loaded: LoadedRecords): Map<string, RecordLink[]> {
  const out = new Map<string, RecordLink[]>();
  for (const r of [...loaded.records].sort((a, b) => a.entry.sequence - b.entry.sequence)) {
    const list = out.get(r.entry.seller) ?? [];
    list.push({ id: r.entry.id, day: r.entry.day, network: r.entry.network });
    out.set(r.entry.seller, list);
  }
  return out;
}

export interface RecordsSiteOptions {
  /** Seller key -> slug of its ranking page (seller/<slug>.html), or null when the seller has no page. */
  sellerSlug: (key: string) => string | null;
  /** The ranking site's page wrapper, so the list looks like the rest of the site. */
  page: (title: string, description: string, body: string) => string;
}

function anchorText(d: LoadedRecords["index"]["days"][number]): string {
  if (d.anchor.status === "anchored" && d.anchor.tx) {
    const url = d.anchor.network.startsWith("solana:") ? `https://solscan.io/tx/${encodeURIComponent(d.anchor.tx)}` : null;
    return `root written on ${esc(chainName(d.anchor.network))} in ${url ? `<a href="${esc(url)}" rel="noopener noreferrer nofollow">${esc(shortHash(d.anchor.tx))}</a>` : esc(d.anchor.tx)}`;
  }
  return "root not yet written on chain";
}

export function renderRecordsSite(loaded: LoadedRecords, opts: RecordsSiteOptions): Map<string, string> {
  const out = new Map<string, string>();
  const bySeller = new Map<string, LoadedRecords["records"]>();
  for (const r of loaded.records) bySeller.set(r.entry.seller, [...(bySeller.get(r.entry.seller) ?? []), r]);
  const sellers = [...bySeller.keys()].sort((a, b) => a.localeCompare(b));
  const anchorId = (key: string) => `s-${(opts.sellerSlug(key) ?? key).replace(/[^A-Za-z0-9._-]+/g, "_")}`;

  for (const r of loaded.records) {
    const slug = opts.sellerSlug(r.entry.seller);
    const nav = [
      `<a href="index.html#${esc(anchorId(r.entry.seller))}">All records</a>`,
      slug ? `<a href="../seller/${esc(slug)}.html">This seller in the ranking</a>` : "",
      `<a href="../index.html">Ranking</a>`,
    ]
      .filter(Boolean)
      .join(" · ");
    out.set(
      `records/${r.entry.id}.html`,
      renderObservationPage(r.obs, { jsonHref: `${r.entry.id}.json`, verifyCommand: verifyCommandFor(r.entry.id), site: { nav, keyHref: OBSERVER_KEYS_URL } }),
    );
  }

  const byVerdict: Record<string, number> = {};
  for (const r of loaded.records) byVerdict[r.entry.verdict] = (byVerdict[r.entry.verdict] ?? 0) + 1;
  const days = loaded.index.days
    .map(
      (d) =>
        `<li><b>${esc(d.day)}</b> · ${d.inRoot} records in the root, ${d.published} published here · root <span class="mono">${esc(shortHash(d.root))}</span> · ${anchorText(d)}</li>`,
    )
    .join("\n");
  const list = sellers
    .map((key) => {
      const slug = opts.sellerSlug(key);
      const rows = bySeller
        .get(key)!
        .sort((a, b) => a.entry.sequence - b.entry.sequence)
        .map((r) => {
          const o = r.obs;
          const when = o.response.receivedAt ?? o.request.ts;
          return `<li><a href="${esc(r.entry.id)}.html">${esc(o.verdict.code)} · ${esc(when ? formatUtc(when) : r.entry.day)} · ${esc(chainName(o.payment.network))} · ${esc(
            formatAmount(o.payment.amount, o.payment.decimals),
          )} ${esc(o.payment.assetSymbol)}</a> · <a href="${esc(r.entry.id)}.json">JSON</a></li>`;
        })
        .join("\n");
      const name = slug ? `<a href="../seller/${esc(slug)}.html">${esc(key)}</a>` : `<span class="mono">${esc(key)}</span>`;
      return `<section id="${esc(anchorId(key))}">
<h3>${name}</h3>
<ul class="plain">
${rows}
</ul>
</section>`;
    })
    .join("\n");
  const counts = Object.entries(byVerdict)
    .map(([v, n]) => `${n} ${v}`)
    .join(", ");
  const bySequence = [...loaded.records].sort((a, b) => a.entry.sequence - b.entry.sequence);
  // A real record id, so the command runs as pasted; the placeholder only when nothing is published.
  const exampleId = bySequence[0]?.entry.id ?? EXAMPLE_PLACEHOLDER;
  const firstDay = [...loaded.records.map((r) => r.entry.day)].sort()[0] ?? null;
  const body = `
<nav><a href="../index.html">Ranking</a> · <a href="../method.html">How vet402 measures</a></nav>
<header>
<h1>vet402 delivery records</h1>
<p class="lead">One signed record per purchase vet402 made with its own money: what it paid, on which chain, and what came back.</p>
<p class="dim">${loaded.records.length} records published (${esc(counts || "none")}) for ${sellers.length} sellers${firstDay ? `, from ${esc(firstDay)}` : ""}. A later day's purchases appear here only after that day's records are built.</p>
</header>

<h2>What is published</h2>
<p>${esc(loaded.index.policy)} Sellers told so far: ${loaded.index.notifiedSellers}.</p>
<p class="meta">The ranking pages already list each seller's failed purchases with their payments. What waits until the seller has been told is the signed record of a failure, not the fact that it failed.</p>
<p class="meta">A record proves that vet402 paid and what HTTP status came back at that time. It does not prove that the content was correct, or that the seller works now.</p>

<h2>Daily roots</h2>
<p class="meta">Every record of a day, published or not, is a leaf of that day's Merkle root, so a record cannot be added or dropped later without changing the root. Each record carries its proof.</p>
<ul class="plain">${days}</ul>

<h2>Check a record</h2>
<p class="meta">No account and no payment needed. The script checks the signature against vet402's published key, the verdict, the Merkle proof, and the payment on chain.</p>
<pre class="cmd">${esc(verifyCommandFor(exampleId))}</pre>${exampleId === EXAMPLE_PLACEHOLDER ? "" : `<p class="meta">The last line checks the first published record, <a href="${esc(exampleId)}.html">${esc(exampleId)}</a>; put any other record id in its place.</p>`}

<h2>By seller</h2>
${list}

<footer><a href="../index.html">Ranking</a><a href="../method.html">How vet402 measures</a><a href="${esc(PUBLIC_REPO_URL)}/tree/main/data/records" rel="noopener noreferrer nofollow">Records (data/records/)</a></footer>
`;
  out.set("records/index.html", opts.page("vet402 delivery records", "Signed records of purchases vet402 made with its own money, grouped by seller.", body));
  return out;
}
