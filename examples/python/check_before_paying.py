#!/usr/bin/env python3
"""Look an x402 seller up in vet402's public record before paying it. Standard library only.

    python3 check_before_paying.py https://api.xona-agent.com/token/pumpfun-trending
    python3 check_before_paying.py <url> --chain base --pay-to 0xabc...

It asks GET https://vet402-delivery.vercel.app/v1/check (free, no key, no payment) and reads `verdict`:

- avoid: vet402 paid this seller and most paid calls were not answered. Do not pay.
- pay or unknown: go on. unknown means too little data, or vet402 never bought from this seller.
- the record cannot be read (network, timeout): go on, and say so. The same rule as the TypeScript
  fetch hook, wrapFetchWithCheck(fetch, { block: "avoid" }).

Exit 0 to go on, 1 on avoid, 2 on bad input.

In your own code, put `pay_after_check(url, pay)` where you pay, or register `vet402_on_payment_required`
on the x402 Python HTTP client (pip install "x402[requests]"). It runs on every 402, with the URL your
code requested, before the client signs anything:

    from x402 import x402ClientSync
    from x402.http import x402HTTPClientSync
    from x402.http.clients.requests import x402_requests, PaymentError
    from check_before_paying import vet402_on_payment_required

    client = x402ClientSync()
    # client.register(<network>, <scheme client>)   your schemes and signer, as usual
    http_client = x402HTTPClientSync(client).on_payment_required(vet402_on_payment_required)
    session = x402_requests(http_client)
    try:
        session.get("https://api.example.com/paid")
    except PaymentError as e:
        print(e)   # on avoid, the payment was never created

The full spec of the answer: https://kzmttkc.github.io/vet402-delivery/use.html#http
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Optional, Tuple, TypeVar

CHECK_ENDPOINT = os.environ.get("VET402_CHECK_ENDPOINT", "https://vet402-delivery.vercel.app/v1/check")

# The chains /v1/check takes by name or CAIP-2 id. Any other network is looked up by URL and payTo only
# (sending it as `chain` would be a 400).
CHAIN_NAMES = {"solana", "tempo", "base", "algorand", "arbitrum", "robinhood"}
CHAIN_IDS = {
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana",
    "eip155:4217": "tempo",
    "eip155:8453": "base",
    "eip155:42161": "arbitrum",
    "eip155:4663": "robinhood",
}
PAY_TO = re.compile(r"^[A-Za-z0-9]{1,128}$")
UNREADABLE = "vet402's record could not be read"

T = TypeVar("T")


def chain_param(network: Optional[str]) -> Optional[str]:
    """The `chain` to send for an x402 network, or None when /v1/check does not know that chain."""
    if not network:
        return None
    n = network.strip()
    if n.lower() in CHAIN_NAMES:
        return n.lower()
    if n.lower().startswith("algorand:"):
        return "algorand"
    return CHAIN_IDS.get(n) or CHAIN_IDS.get(n.lower())


def check(url: str, chain: Optional[str] = None, pay_to: Optional[str] = None, timeout: float = 10.0) -> dict:
    """GET /v1/check and return the JSON answer. Raises ValueError on a 400, OSError when it cannot be read."""
    params = {"url": url}
    c = chain_param(chain)
    if c:
        params["chain"] = c
    if pay_to and PAY_TO.match(pay_to):
        params["payTo"] = pay_to
    req = urllib.request.Request(
        f"{CHECK_ENDPOINT}?{urllib.parse.urlencode(params)}",
        headers={"accept": "application/json", "user-agent": "vet402-check-python-example"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 400:
            try:
                message = json.loads(e.read().decode("utf-8")).get("message")
            except ValueError:
                message = None
            raise ValueError(message or "bad request") from None
        raise


def should_pay(url: str, chain: Optional[str] = None, pay_to: Optional[str] = None) -> Tuple[bool, str]:
    """(False, why) on avoid; (True, why) on pay, unknown, or a record that cannot be read."""
    try:
        answer = check(url, chain, pay_to)
    except json.JSONDecodeError as e:  # before ValueError: it is one
        return True, f"{UNREADABLE} ({e}); going on without it."
    except ValueError:
        raise
    except OSError as e:
        return True, f"{UNREADABLE} ({e}); going on without it."
    if not isinstance(answer, dict):
        return True, f"{UNREADABLE} (the answer was not a JSON object); going on without it."
    verdict = answer.get("verdict")
    why = f"vet402: {verdict}. {answer.get('why', '')}".strip()
    if verdict == "avoid":
        page = answer.get("sellerPage")
        return False, f"{why} Details: {page}" if page else why
    return True, why


def pay_after_check(url: str, pay: Callable[[str], T], chain: Optional[str] = None, pay_to: Optional[str] = None) -> Optional[T]:
    """Call `pay(url)` only when the verdict is not avoid. On avoid, `pay` is never called and None is returned."""
    ok, why = should_pay(url, chain, pay_to)
    print(why, file=sys.stderr)
    if not ok:
        return None
    return pay(url)


class Vet402Avoid(Exception):
    """Raised by vet402_on_payment_required on avoid. The x402 requests client turns it into its PaymentError."""


def vet402_on_payment_required(ctx: Any) -> None:
    """An on_payment_required hook for the x402 Python HTTP client (x402HTTPClientSync).

    Looks up `ctx.request_url` (the URL the code requested, not one the 402 names) once for each network and
    payTo the 402 offers, and raises Vet402Avoid when any of them is avoid: the client cannot know yet which
    offer it will pay, so the same rule as the fetch hook. Returns None to go on (pay, unknown, a record that
    cannot be read, which prints one line to stderr, or a URL /v1/check does not take).
    """
    url = getattr(ctx, "request_url", None)
    if not isinstance(url, str) or not url:
        return None
    offers = getattr(ctx.payment_required, "accepts", None) or [None]
    asks = []
    for o in offers:
        ask = (getattr(o, "network", None), getattr(o, "pay_to", None))
        if ask not in asks:
            asks.append(ask)
    said = False
    for network, pay_to in asks:
        try:
            ok, why = should_pay(url, network, pay_to)
        except ValueError as e:  # a URL /v1/check refuses (400): nothing to look up
            print(f"vet402: {url} was not looked up ({e}); going on.", file=sys.stderr)
            return None
        if not ok:
            raise Vet402Avoid(why)
        if why.startswith(UNREADABLE) and not said:  # one line, however many offers
            print(why, file=sys.stderr)
            said = True
    return None


def main(argv: list) -> int:
    args = list(argv)
    opts = {}
    for flag in ("--chain", "--pay-to"):
        if flag in args:
            i = args.index(flag)
            if i + 1 >= len(args):
                print(f"{flag} needs a value", file=sys.stderr)
                return 2
            opts[flag] = args[i + 1]
            del args[i : i + 2]
    if len(args) != 1:
        print("usage: check_before_paying.py <seller URL> [--chain <name|CAIP-2>] [--pay-to <address>]", file=sys.stderr)
        return 2
    try:
        ok, why = should_pay(args[0], opts.get("--chain"), opts.get("--pay-to"))
    except ValueError as e:
        print(e, file=sys.stderr)
        return 2
    print(why)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
