/**
 * The values vet402 puts into a seller's input when the catalog gave none it can send, and the inputs vet402
 * never makes up. Pure: no network, no I/O.
 *
 * Each value is a real, public thing (a public DNS resolver, a public company's domain, a public organisation's
 * account), never a placeholder (`string`, `example`, `<id>`) and never a private person's data. Where a value
 * comes from is written next to it (`from`), and every filled parameter records which rule gave it, so a result
 * row can be traced back to this table.
 */

export type ParamClass =
  | "ip"
  | "domain"
  | "web_url"
  | "linkedin_company_url"
  | "company_name"
  | "street_address"
  | "social_handle"
  | "vin"
  | "date"
  | "crypto_symbol"
  | "stock_symbol"
  | "fiat_currency"
  | "search_query"
  | "location_query"
  | "llm_prompt"
  | "chat_messages"
  | "latitude"
  | "longitude"
  | "city"
  | "us_state"
  | "country"
  | "postal_code"
  | "language";

export interface TableValue {
  cls: ParamClass;
  /** A JSON value, or "today" for the UTC date of the run. */
  value: unknown;
  /** Where the value comes from. */
  from: string;
}

/** The value table. One value per class, so every seller is asked the same thing and results compare. */
export const VALUE_TABLE: Readonly<Record<ParamClass, TableValue>> = {
  ip: { cls: "ip", value: "8.8.8.8", from: "Google Public DNS resolver address (published by Google)" },
  domain: { cls: "domain", value: "stripe.com", from: "public company domain; the domain Company Enrich's own catalog entry gives as its example (Mercator orth-company-enrich, 2026-09-30)" },
  web_url: { cls: "web_url", value: "https://www.wikipedia.org/", from: "public web page" },
  linkedin_company_url: { cls: "linkedin_company_url", value: "https://www.linkedin.com/company/stripe", from: "public LinkedIn page of the company in `domain`" },
  company_name: { cls: "company_name", value: "Stripe", from: "the company in `domain`" },
  street_address: { cls: "street_address", value: "354 Oyster Point Blvd, South San Francisco, CA 94080", from: "published headquarters address of the company in `domain`" },
  social_handle: { cls: "social_handle", value: "nasa", from: "public account of a public organisation (NASA)" },
  vin: { cls: "vin", value: "1HGCM82633A004352", from: "the VIN in agents.datamancer.io's own output example (CDP Bazaar listing of /api/v1/paid/vin, read 2026-09-30)" },
  date: { cls: "date", value: "today", from: "the UTC date of the run" },
  crypto_symbol: { cls: "crypto_symbol", value: "USDC", from: "the token vet402 pays with" },
  stock_symbol: { cls: "stock_symbol", value: "AAPL", from: "public listed company ticker" },
  fiat_currency: { cls: "fiat_currency", value: "USD", from: "ISO 4217 code of the currency USDC tracks" },
  search_query: { cls: "search_query", value: "stablecoin payments", from: "a plain web search" },
  location_query: { cls: "location_query", value: "San Francisco", from: "a public place name" },
  llm_prompt: { cls: "llm_prompt", value: "Reply with the single word: ok", from: "a minimal prompt" },
  chat_messages: { cls: "chat_messages", value: [{ role: "user", content: "Reply with the single word: ok" }], from: "a minimal chat in the OpenAI message shape" },
  latitude: { cls: "latitude", value: 37.7749, from: "San Francisco" },
  longitude: { cls: "longitude", value: -122.4194, from: "San Francisco" },
  city: { cls: "city", value: "San Francisco", from: "a public place name" },
  us_state: { cls: "us_state", value: "CA", from: "a public place name" },
  country: { cls: "country", value: "US", from: "ISO 3166-1 alpha-2" },
  postal_code: { cls: "postal_code", value: "94103", from: "San Francisco ZIP code" },
  language: { cls: "language", value: "en", from: "ISO 639-1" },
};

/**
 * Classes where vet402 sends its own table value even when the seller documents an example or a default. A
 * seller's example street address can be someone's home (the default in rentcast.x402.paysponge.com's
 * /openapi.json for /avm/rent/long-term is a street address of that kind), and the request and the answer about
 * it are published in data/. The
 * table value is a company's published headquarters, public already.
 */
export const TABLE_ONLY: ReadonlySet<ParamClass> = new Set<ParamClass>(["street_address"]);

/**
 * Inputs vet402 does not make up. A parameter in one of these is left as it is; a request that needs one is not
 * bought again (the target stays as it was, and the existing skip of a placeholder request applies).
 */
export type Unfillable =
  | "personal_data" // an email address, a phone number, a person's name: vet402 sends no one's personal data
  | "needs_own_id" // the id of a job, invoice, prediction or record only an earlier call by vet402 could have made
  | "secret" // a key, token or password
  | "unknown_param"; // nothing above says what the parameter is

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Parameter names (folded: lower case, letters and digits only) by class. */
const NAMES: readonly [ParamClass, RegExp][] = [
  ["ip", /^(ip|ipaddress|ipaddr|ipv4)$/],
  ["linkedin_company_url", /^(licompanyurl|linkedincompanyurl|companylinkedinurl|linkedinurl|linkedin)$/],
  ["domain", /^(domain|website|companydomain|companywebsite|hostname|host|site)$/],
  ["web_url", /^(url|pageurl|weburl|targeturl|link|sourceurl|websiteurl)$/],
  ["vin", /^vin$/],
  ["social_handle", /^(handle|username|screenname)$/],
  ["company_name", /^(companyname|company|businessname|organization|organisation)$/],
  ["street_address", /^(address|streetaddress|fulladdress|addressline1)$/],
  ["date", /^(date|day|startdate|enddate|fromdate|todate|asof|asofdate)$/],
  ["latitude", /^(lat|latitude)$/],
  ["longitude", /^(lon|lng|long|longitude)$/],
  ["city", /^city$/],
  ["us_state", /^state$/],
  ["country", /^(country|countrycode)$/],
  ["postal_code", /^(zip|zipcode|postcode|postalcode)$/],
  ["language", /^(lang|language|hl)$/],
  ["chat_messages", /^messages$/],
  ["llm_prompt", /^(prompt|instruction|instructions)$/],
  ["search_query", /^(q|query|search|keyword|keywords|searchquery|term|text)$/],
];

const SITE_SPECIFIC = /\b(komi|linkedin|instagram|tiktok|youtube|twitter|x\.com|reddit|facebook|amazon|github|spotify|pinterest|threads|snapchat|twitch|discord|etsy|ebay|shopify|google maps|zillow|product page|profile|post url|video url)\b/;
const SOCIAL = /\b(instagram|tiktok|youtube|twitter|x\.com|threads|facebook|linkedin|twitch|snapchat|pinterest|reddit|bluesky|creator)\b/;
const PERSONAL = /^(email|emailaddress|mail|phone|phonenumber|tonumber|mobile|recipient|firstname|lastname|fullname|personname|dob|birthdate|ssn)$/;
const OWN_ID = /(^id$|uuid|jobid|job$|predictionid|submissionid|taskid|invoiceid|orderid|requestid|runid|sessionid|agentid|numberid|hash$|cursor$|^token$)/;
const SECRET = /(apikey|secret|password|passwd|accesstoken|authtoken|bearertoken|privatekey|mnemonic|^seed$|seedphrase)/;

export interface Classified {
  cls?: ParamClass;
  unfillable?: Unfillable;
}

/**
 * What a parameter is, from its name, then its description. `symbol` and `currency` read the description to tell
 * a stock ticker from a token and a fiat currency; `text`/`query` read it to tell a place search from a web search.
 */
export function classify(name: string, description = ""): Classified {
  const n = norm(name);
  const d = description.toLowerCase();
  if (SECRET.test(n)) return { unfillable: "secret" };
  if (PERSONAL.test(n)) return { unfillable: "personal_data" };
  if (n === "symbol" || n === "ticker" || n === "symbols" || n === "tickers") {
    if (/\b(stock|equit|ticker|nasdaq|nyse|share)/.test(d) || n.startsWith("ticker")) return { cls: "stock_symbol" };
    return { cls: "crypto_symbol" };
  }
  if (n === "currency" || n === "asset" || n === "coin" || n === "tokensymbol") {
    if (/\biso ?4217\b|\bfiat\b/.test(d)) return { cls: "fiat_currency" };
    return { cls: "crypto_symbol" };
  }
  if (n === "name") return /\b(business|company|organi[sz]ation|brand)\b/.test(d) ? { cls: "company_name" } : { unfillable: "unknown_param" };
  for (const [cls, re] of NAMES) {
    if (!re.test(n)) continue;
    // A page on one particular site ("URL to Komi page", "Instagram post URL"): a general web page would be wrong.
    if (cls === "web_url" && (SITE_SPECIFIC.test(d) || /\bto (a |an |the )?[A-Z]/.test(description))) return { unfillable: "unknown_param" };
    if (cls === "search_query" && /\b(location|place|city|address|geocod)/.test(d)) return { cls: "location_query" };
    // A handle only on a named social platform: a "username" of an inbox or an account elsewhere is not a public one.
    if (cls === "social_handle" && !SOCIAL.test(d)) return { unfillable: "unknown_param" };
    if (cls === "street_address" &&/\b(wallet|0x|solana|base58|ethereum|evm|account)\b/.test(d)) return { unfillable: "unknown_param" };
    if (cls === "linkedin_company_url" && n === "linkedin" && !/\bcompan|organi[sz]ation|url\b/.test(d)) return { unfillable: "unknown_param" };
    return { cls };
  }
  if (OWN_ID.test(n)) return { unfillable: "needs_own_id" };
  return { unfillable: "unknown_param" };
}

/** The table's value for a class; "today" becomes the run's UTC date (YYYY-MM-DD). */
export function tableValue(cls: ParamClass, today: string): unknown {
  const v = VALUE_TABLE[cls].value;
  return v === "today" ? today : structuredClone(v);
}

/** Shape a value must have for its class, used to accept a seller's own example of that class. */
export const CLASS_SHAPE: Partial<Record<ParamClass, RegExp>> = {
  ip: /^\d{1,3}(\.\d{1,3}){3}$/,
  domain: /^(?!www\.)[a-z0-9-]+(\.[a-z0-9-]+)+$/i,
  web_url: /^https:\/\/\S+$/,
  linkedin_company_url: /^https:\/\/(www\.)?linkedin\.com\/company\/\S+$/,
  vin: /^[A-HJ-NPR-Z0-9]{17}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
};
