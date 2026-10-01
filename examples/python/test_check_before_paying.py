"""Tests for check_before_paying.py against a local mock of /v1/check. Standard library only, no network.

    python3 -m unittest discover -s examples/python -p 'test_*.py'
"""

from __future__ import annotations

import dataclasses
import json
import os
import subprocess
import sys
import threading
import types
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import check_before_paying as cbp  # noqa: E402

AVOID_URL = "https://avoid.example/paid"
PAY_URL = "https://pay.example/paid"
UNKNOWN_URL = "https://unknown.example/paid"
BROKEN_URL = "https://broken.example/paid"


class Mock(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):  # quiet
        pass

    def do_GET(self):
        q = urllib.parse.urlparse(self.path)
        params = dict(urllib.parse.parse_qsl(q.query))
        Mock.seen.append(params)
        url = params.get("url", "")
        if not url.startswith("https://"):
            return self.reply(400, {"error": "bad_request", "message": "Only https URLs can be checked."})
        if url == BROKEN_URL:
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(b"not json")
            return None
        verdict = {AVOID_URL: "avoid", PAY_URL: "pay"}.get(url, "unknown")
        why = {
            "avoid": "vet402 paid this seller 6 times on Solana over 4 days; 0 of 6 paid calls answered.",
            "pay": "vet402 paid this seller 12 times over 5 days; 12 of 12 paid calls answered.",
            "unknown": "vet402 has no record of this seller.",
        }[verdict]
        body = {"verdict": verdict, "why": why, "url": url, "sellerPage": "https://kzmttkc.github.io/vet402-delivery/seller/x.html" if verdict == "avoid" else None}
        return self.reply(200, body)

    def reply(self, status, body):
        data = (json.dumps(body, indent=2) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@dataclasses.dataclass
class FakeAbortResult:
    reason: str
    message: object = None


class CheckBeforePayingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.endpoint = f"http://127.0.0.1:{cls.server.server_address[1]}/v1/check"
        cls.saved = cbp.CHECK_ENDPOINT
        cbp.CHECK_ENDPOINT = cls.endpoint
        # x402's AbortResult, without installing x402: the hook imports it only on avoid.
        cls.saved_x402 = sys.modules.get("x402")
        sys.modules["x402"] = types.SimpleNamespace(AbortResult=FakeAbortResult)

    @classmethod
    def tearDownClass(cls):
        cbp.CHECK_ENDPOINT = cls.saved
        if cls.saved_x402 is None:
            sys.modules.pop("x402", None)
        else:
            sys.modules["x402"] = cls.saved_x402
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        Mock.seen.clear()

    def paid(self):
        calls = []

        def pay(url):
            calls.append(url)
            return "paid"

        return calls, pay

    def test_avoid_never_pays(self):
        calls, pay = self.paid()
        self.assertIsNone(cbp.pay_after_check(AVOID_URL, pay))
        self.assertEqual(calls, [], "on avoid, pay is never called")
        self.assertEqual(Mock.seen[-1]["url"], AVOID_URL)

    def test_pay_and_unknown_go_on(self):
        for url in (PAY_URL, UNKNOWN_URL):
            calls, pay = self.paid()
            self.assertEqual(cbp.pay_after_check(url, pay), "paid")
            self.assertEqual(calls, [url])

    def test_unreadable_record_goes_on(self):
        calls, pay = self.paid()
        self.assertEqual(cbp.pay_after_check(BROKEN_URL, pay), "paid", "an answer that is not JSON goes on")
        saved = cbp.CHECK_ENDPOINT
        try:
            cbp.CHECK_ENDPOINT = "http://127.0.0.1:9/v1/check"  # nothing listens: connection refused
            ok, why = cbp.should_pay(AVOID_URL)
        finally:
            cbp.CHECK_ENDPOINT = saved
        self.assertTrue(ok)
        self.assertIn("could not be read", why)

    def test_bad_input_is_an_error_not_a_payment(self):
        with self.assertRaises(ValueError) as e:
            cbp.should_pay("http://plain.example/")
        self.assertIn("Only https URLs", str(e.exception))

    def test_query_chain_and_pay_to(self):
        cbp.check(PAY_URL, "eip155:8453", "0xAbC123")
        self.assertEqual(Mock.seen[-1], {"url": PAY_URL, "chain": "base", "payTo": "0xAbC123"})
        cbp.check(PAY_URL, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "not/an address")
        self.assertEqual(Mock.seen[-1], {"url": PAY_URL, "chain": "solana"}, "a payTo of other characters is not sent")
        cbp.check(PAY_URL, "eip155:137")
        self.assertEqual(Mock.seen[-1], {"url": PAY_URL}, "a chain /v1/check does not know is not sent")
        self.assertEqual(cbp.chain_param("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k"), "algorand")
        self.assertEqual(cbp.chain_param("Base"), "base")

    def test_x402_hook_aborts_on_avoid(self):
        req = types.SimpleNamespace(network="solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", pay_to="PayTo111")
        v2 = types.SimpleNamespace(payment_required=types.SimpleNamespace(resource=types.SimpleNamespace(url=AVOID_URL)), selected_requirements=req)
        out = cbp.vet402_before_payment(v2)
        self.assertIsInstance(out, FakeAbortResult)
        self.assertEqual(out.reason, "vet402_avoid")
        self.assertIn("vet402: avoid.", out.message)
        self.assertEqual(Mock.seen[-1], {"url": AVOID_URL, "chain": "solana", "payTo": "PayTo111"})
        # x402 v1: the URL is on the requirement.
        v1 = types.SimpleNamespace(payment_required=types.SimpleNamespace(), selected_requirements=types.SimpleNamespace(network="base", pay_to="0x1", resource=AVOID_URL))
        self.assertIsInstance(cbp.vet402_before_payment(v1), FakeAbortResult)

    def test_x402_hook_goes_on(self):
        req = types.SimpleNamespace(network="eip155:8453", pay_to="0x1")
        for url in (PAY_URL, UNKNOWN_URL):
            ctx = types.SimpleNamespace(payment_required=types.SimpleNamespace(resource=types.SimpleNamespace(url=url)), selected_requirements=req)
            self.assertIsNone(cbp.vet402_before_payment(ctx))
        no_url = types.SimpleNamespace(payment_required=types.SimpleNamespace(resource=None), selected_requirements=req)
        self.assertIsNone(cbp.vet402_before_payment(no_url))

    def test_command_line_exit_codes(self):
        script = os.path.join(HERE, "check_before_paying.py")
        env = {**os.environ, "VET402_CHECK_ENDPOINT": self.endpoint}

        def run(*args):
            return subprocess.run([sys.executable, script, *args], env=env, capture_output=True, text=True, timeout=30)

        avoid = run(AVOID_URL)
        self.assertEqual(avoid.returncode, 1, avoid.stderr)
        self.assertTrue(avoid.stdout.startswith("vet402: avoid."))
        self.assertEqual(run(PAY_URL).returncode, 0)
        self.assertEqual(run(UNKNOWN_URL, "--chain", "base").returncode, 0)
        self.assertEqual(run("http://plain.example/").returncode, 2)
        self.assertEqual(run().returncode, 2)


if __name__ == "__main__":
    unittest.main()
