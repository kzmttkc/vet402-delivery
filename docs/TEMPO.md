# vet402 on Tempo: the Mercator census

Mercator (Tempo, 2026-09-23) routes agents to paid MPP/x402 tools and ranks them. vet402 adds the
third-party part: it buys each service once with its own money and records, per purchase, whether
the transfer settled on chain and whether the service delivered (paid HTTP 2xx), with the tx hash.

Measured 2026-09-28. Primary sources are linked in each row.

## 1. Funding facts (Tempo mainnet)

| fact | value | source |
|---|---|---|
| chain | Tempo mainnet, chainId **4217** (`eip155:4217`). Testnet Moderato is 42431 and is refused by the guard | `eth_chainId` on https://rpc.tempo.xyz = `0x1079`; https://mpp.dev/payment-methods/tempo/charge |
| token MPP charges are paid in | **USDC.e** (Bridged USDC (Stargate)), `0x20c000000000000000000000b9537d11c60e8b50`, 6 decimals. Every Tempo endpoint in the MPP directory (1,272 of 1,272 priced) and every live 402 read by the census (118 of 118) asks for USDC.e | on-chain `name()/symbol()/decimals()`; https://mpp.dev/api/services; https://mercator.sh/docs.md ("Mercator displays prices denominated in USDC.e") |
| other tokens | pathUSD `0x20c0…0000` (Mercator can auto-swap from it), MACH `0x20c0…f37de3740adec032` (Mercator credit, 1 USD = 1 MACH, spendable only at approved merchants, not transferable). Neither is needed for direct purchases | https://mercator.sh/docs.md ("Funding and MACH") |
| native gas token | **none**. "Tempo has no native token"; fees are paid in a USD TIP-20 | https://tempo.xyz/developers/docs/protocol/fees |
| which token pays the fee | order: tx `feeToken` > account default > **the TIP-20 being transferred** > pathUSD. A USDC.e `transfer` therefore pays its fee in USDC.e. Holding only USDC.e is enough | https://tempo.xyz/developers/docs/protocol/fees/spec-fee |
| fee size | ~50,000 gas TIP-20 transfer: about $0.0006 at the base-fee cap, $0.00003 at the floor | same page |
| who pays the fee | per challenge: `feePayer: true` = the seller sponsors (payer needs no fee). Of the 87 payable services, **41 sponsor, 46 do not** (payer pays the fee in USDC.e). The census reserves 0.002 USDC.e per unsponsored purchase against its cap | live 402s (`results/tempo-census-2026-09-28.dry-run.json`) |
| first transaction from a fresh account | extra cost not stated in the fee docs [unverified]; covered by the 0.002 reserve | https://tempo.xyz/developers/docs/protocol/fees |
| payer | `0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51` (plain 20-byte EVM address, same as on Base). Balance 2026-09-28: USDC.e 0, pathUSD 0, MACH 0, nonce 0 | on-chain `balanceOf` / `eth_getTransactionCount` |
| **amount to send** | **2.11 USDC.e** covers the full guarded census (2.015 in prices + 0.092 fee reserve). Send **2.50 USDC.e** on Tempo mainnet to the payer (the default `--cap` is 2.50) | dry run below |

Cost of "every service once", by scope (USDC.e unless marked):

| scope | services | total |
|---|---|---|
| guarded census (price <= 0.10, input known, 402 read live) | 87 | **2.015** (+0.092 fee reserve) |
| every Tempo service that returned a live 402, no price cap | 118 | 3,219.83 (3,194.31 of it is three real-world purchases: sayer-and-stone 3,101.63, martin-estate 51.72, billboard 40.96); 7.52 without the 6 items above 1.00 |
| cheapest fixed catalog price, all Tempo services found | 146 | 5.17 |
| x402 services reached by the sweep (paid on Base USDC, not Tempo) | 315 | 8.42 Base USDC |

## 2. Mercator's directory and ranking

- API: `GET https://mercator.sh/v1/services/search` (ranked, <= 25 per query) and `GET /v1/services/{id}`
  (https://mercator.sh/openapi.json). **There is no list-all endpoint.**
- Catalog size (diagnostic search `evidence=pre-confidence`, `internal.catalog`): **2,410 services /
  30,167 endpoints**, generated 2026-09-17T07:38:58Z, aggregated from 9 sources (mpp.dev directory,
  MPP proxy directory, CDP x402 Bazaar, TOLL402, Orthogonal, Locus, AIsa, Zinc, Stripe Projects).
- Ranking: `internal.retrieval.ranking = { profile: "rank-fusion-v9", strategy: "relevance-price-v1" }`.
  The public score has two parts, `relevance` and `price`. **Mercator exposes no reliability score.**
  The only quality signal is `quality.tier` (`standard` / `reviewed` / `tempo-managed`). Rank is per
  query, so the census records each service's best rank across 66 capability queries.
- Enumeration used by the census: mpp.dev directory ids (142) + `orth-<slug>` from
  https://mpp.orthogonal.com (65) + every service returned by the 66-query sweep (350) = 482 ids;
  463 exist in Mercator: **146 pay on Tempo** (MPP charge), 315 x402 (Base), 2 other. A 552-query
  sweep reached 1,124 services, which puts Mercator's x402 side at roughly 2,260 services.
- Mercator's cataloged price and the live 402 disagree for 4 of the Tempo endpoints the census
  chose: agentmail `/v0/domains` 0.01 in the catalog vs 10.00 live, dripstack 1.00 vs 6.00,
  orth-fantastic-jobs 0.01 vs 0.40, stability-ai 0 vs 0.001.

Tempo services that reached a Mercator rank in the sweep (35 of 146), with the census verdict:

| Mercator rank | service | query (best rank) | score (relevance / price) | tier | live price (USDC.e) | fee | census verdict |
|---|---|---|---|---|---|---|---|
| 1 | fal | video generation | 0.975 (1.000 / 0.500) | tempo-managed | 0.48 | sponsored | price_over_cap |
| 1 | stableemail | send email | 0.967 (1.000 / 0.333) | reviewed | 0.001 | self | payable |
| 1 | stabletravel | flight search | 0.955 (1.000 / 0.091) | reviewed | - | - | unpaid_404 |
| 1 | orth-serper | patents | 0.814 (0.812 / 0.833) | reviewed | 0.002 | sponsored | payable |
| 1 | modal | code sandbox execution | 0.793 (0.808 / 0.500) | tempo-managed | 0.0001 | sponsored | payable |
| 1 | orth-apollo | contact enrichment | 0.780 (0.795 / 0.500) | reviewed | - | - | unpaid_400 |
| 1 | stablephone | phone lookup | 0.780 (0.812 / 0.167) | reviewed | 0.05 | self | payable |
| 1 | codex | blockchain data | 0.550 (0.531 / 0.909) | reviewed | 0.001 | self | payable |
| 1 | stableenrich | technology stack of a company | 0.493 (0.512 / 0.143) | reviewed | 0.002 | self | payable |
| 1 | parallel | pdf extraction | 0.364 (0.357 / 0.500) | reviewed | 0.01 | self | payable |
| 2 | deepl | translation | 0.793 (0.808 / 0.500) | reviewed | 0.005 | self | payable |
| 2 | exa | web search | 0.788 (0.804 / 0.500) | reviewed | 0.007 | sponsored | payable |
| 2 | stablesocial | social media posts | 0.591 (0.615 / 0.143) | reviewed | 0.06 | self | payable |
| 2 | stablestudio | video generation | 0.553 (0.576 / 0.125) | reviewed | 0.01 | self | payable |
| 2 | quicknode | blockchain data | 0.456 (0.432 / 0.909) | reviewed | - | - | no_fillable_endpoint |
| 2 | orth-scrapegraphai | pdf extraction | 0.399 (0.393 / 0.500) | reviewed | 0.005 | sponsored | payable |
| 3 | edgar | company financials | 0.772 (0.784 / 0.556) | reviewed | 0.008 | self | payable |
| 3 | brave | video generation | 0.450 (0.462 / 0.222) | reviewed | 0.035 | self | payable |
| 3 | tavily | pdf extraction | 0.394 (0.389 / 0.500) | reviewed | 0.09 | self | payable |
| 3 | zinc | product search shopping | 0.300 (0.289 / 0.500) | reviewed | 0.01 | self | payable |
| 4 | orth-olostep | scrape a web page | 0.731 (0.743 / 0.500) | reviewed | 0.01 | sponsored | payable |
| 5 | orth-linkup | web search | 0.705 (0.716 / 0.500) | reviewed | 0.01 | sponsored | payable |
| 5 | openweather | travel | 0.507 (0.504 / 0.556) | reviewed | 0.005 | self | payable |
| 6 | orth-riveter | scrape a web page | 0.695 (0.705 / 0.500) | reviewed | 0.209 | sponsored | price_over_cap |
| 6 | perplexity | web search | 0.517 (0.518 / 0.500) | reviewed | 0.009358 | self | payable |
| 6 | dripstack | twitter x posts | 0.418 (0.414 / 0.500) | standard | 6 | self | price_over_cap |
| 7 | edgar-search | sec filings | 0.720 (0.728 / 0.556) | reviewed | 0.008 | self | payable |
| 7 | orth-andi | web search | 0.502 (0.502 / 0.500) | standard | 0.01 | sponsored | payable |
| 8 | deepgram | text to speech | 0.775 (0.799 / 0.303) | reviewed | 0.013 | self | payable |
| 8 | mistral | embeddings | 0.749 (0.759 / 0.556) | standard | 0.008 | self | payable |
| 9 | alphavantage | stock quotes | 0.710 (0.718 / 0.556) | reviewed | 0.008 | self | payable |
| 9 | stableupload | storage | 0.258 (0.245 / 0.500) | reviewed | 0.02 | self | payable |
| 10 | groq | llm chat completion | 0.769 (0.783 / 0.500) | standard | 0.008 | self | payable |
| 13 | coingecko | crypto prices | 0.451 (0.467 / 0.143) | reviewed | 0.06 | self | payable |
| 16 | orth-precip | sports data | 0.366 (0.359 / 0.500) | reviewed | - | - | unpaid_400 |

The full list (146 Tempo + 317 others, with rank, tier, endpoint, catalog and live price, recipient,
feePayer) is `results/tempo-census-2026-09-28.dry-run.json`.

## 3. Dry run (2026-09-28)

```
npx tsx scripts/tempo-census.ts --dry-run
```

146 Tempo services probed unpaid:

| verdict | n | meaning |
|---|---|---|
| payable | 87 | live 402 passes every guard; in the plan |
| price_over_cap | 18 | live price > 0.10 |
| unpaid_404 / 400 / 410 / 422 / 501 | 13 / 6 / 1 / 1 / 1 | the cataloged endpoint does not answer 402 (e.g. all 10 `abstract-*` return 404) |
| no_input_example | 10 | payable, but Mercator has no input for it: a paid call would likely 4xx (vouch's main failure, below) |
| no_fillable_endpoint | 4 | every Tempo endpoint needs a path parameter with no example |
| bad_amount | 3 | live 402 asks for amount 0 |
| no_tempo_charge / probe_error | 1 / 1 | |

## 4. vouch's Tempo lane: 62 settled, 15 delivered, why not the other 47

Public numbers (https://vet402.com/api/v1/observatory/state, `l1.byChain` Tempo): 72 attempts,
62 settled, 15 delivered. Per-row data: https://vet402.com/api/v1/observatory/export.csv?days=30
(72 rows on `eip155:4217`, 2026-09-17 to 2026-09-28). Re-derive with
`npx tsx scripts/vouch-tempo-breakdown.ts`.

| cause | rows | side | evidence |
|---|---|---|---|
| paid response 4xx (400 x21, 422 x8, 404 x2) | **31** | **vet402** | vouch's MPP catalog rows have no declared input (`mpp-directory.ts`: `declaredSchema: null`), so the lane POSTed `{}` (request_body `empty`) or sent a GET with no query (`none`). Endpoints such as openai `/v1/audio/speech`, serpapi `/search`, fal image models need input. vouch already holds these as inconclusive `settled_4xx` |
| no HTTP response | **3** | **vet402** | latency 20.2-20.8 s = vouch's L1 timeout (`l1-runner.ts` `timeoutMs = 20_000`). Two are fal image generations (flux/dev, SD 3.5 large), one predictleads. The transfer settled (tx linked later by vet402's index); the response was cut off by vet402 |
| paid response 5xx | **13** | seller | goflightlabs 502 x5 (4 endpoints, 09-22 to 09-28), fiber tiktok 503 x2 / 500 x1, aviato 500 x1. Four of the 13 were likely provoked by vet402's empty input: firecrawl `/v1/search` 500 x2 (sent `{}`, a search needs a query) and modal `/sandbox/terminate` 500 x2 (needs a sandbox id) |

So 34 of 47 (31 + 3) are vet402's side, and up to 38 if the four input-provoked 5xx are counted.
The census fixes both: it only plans endpoints whose input Mercator catalogs (`inputExample`), and it
waits 90 s for a paid response.

## 5. `--pay` (built, not run)

```
npx tsx scripts/tempo-census.ts --pay --plan results/tempo-census-2026-09-28.dry-run.json \
  --key ~/vet402-solana/.keys/evm.json [--cap 2.50] [--max N]
```

Per purchase, in this order (src/tempo/pay.ts): re-read the live 402; guard (tempo/charge, chainId
4217 only, USDC.e only, amount <= 0.10, amount <= dry-run amount, recipient = dry-run recipient and
in Mercator's `recipientPolicy` allowlist, no splits, pull mode, not expired); USDC.e balance >=
price + fee reserve; reserve in the ledger (`results/tempo-ledger.json`, written before signing; the
total cap is checked against max(ledger, on-chain USDC.e outflow since block 41,600,000)); sign with
mppx in pull mode (the tx stays in the process); decode the signed tx and require exactly one USDC.e
`transfer`/`transferWithMemo` of that amount to that recipient, signed by the payer, on 4217, fee in
USDC.e; only then send the paid request (redirects refused, 90 s timeout); re-read the receipt on
chain; record settled and delivered separately with the tx hash.
