"""LangChain (Python): a tool that looks a seller up in vet402's public record before an agent pays it.

    pip install langchain-core

    from vet402_tool import check_x402_seller, pay_after_check
    agent = create_agent(model, tools=[check_x402_seller, ...])

Python cannot load the npm package, so this reads GET /v1/check (free, no key, standard library only).
The answer starts with the verdict (pay, avoid or unknown) and one sentence of why. pay_after_check(url, pay)
calls pay(url) only when the verdict is not avoid and the record could be read.
VET402_CHECK_ENDPOINT points it at another copy of /v1/check (the tests use one on loopback).
"""
import json
import os
import urllib.parse
import urllib.request
from typing import Callable, Optional, TypeVar

ENDPOINT = os.environ.get("VET402_CHECK_ENDPOINT", "https://vet402-delivery.vercel.app/v1/check")
T = TypeVar("T")

try:
    from langchain_core.tools import tool
except ImportError:  # langchain-core not installed: the functions still work, without the tool wrapper

    def tool(fn):  # type: ignore[no-redef]
        return fn


def lookup(url: str, chain: Optional[str] = None, pay_to: Optional[str] = None) -> dict:
    """GET /v1/check for one URL. Raises on a network error or a non-200 answer."""
    query = {"url": url}
    if chain:
        query["chain"] = chain
    if pay_to:
        query["payTo"] = pay_to
    with urllib.request.urlopen(ENDPOINT + "?" + urllib.parse.urlencode(query), timeout=20) as res:
        return json.loads(res.read().decode("utf-8"))


@tool
def check_x402_seller(url: str, chain: Optional[str] = None, pay_to: Optional[str] = None) -> str:
    """Look an x402 seller up in vet402's public record before paying it. Returns the verdict (pay, avoid or unknown) and why."""
    try:
        answer = lookup(url, chain, pay_to)
    except Exception as e:  # noqa: BLE001 - the agent gets the failure as text
        return "vet402's record could not be read (%s). Nothing is known about this seller from it." % e
    return "verdict: %s. %s" % (answer.get("verdict"), answer.get("why"))


def pay_after_check(url: str, pay: Callable[[str], T]) -> Optional[T]:
    """Call pay(url) unless vet402's verdict is avoid. With no answer from vet402, pay is not called."""
    answer = lookup(url)
    if answer.get("verdict") == "avoid":
        return None
    return pay(url)
