"""Tests for check_before_paying.py against a local mock of /v1/check. Standard library only, no network.

    python3 -m unittest discover -s examples/python -p 'test_*.py'
"""

from __future__ import annotations

import base64
import contextlib
import io
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


class CheckBeforePayingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.endpoint = f"http://127.0.0.1:{cls.server.server_address[1]}/v1/check"
        cls.saved = cbp.CHECK_ENDPOINT
        cbp.CHECK_ENDPOINT = cls.endpoint

    @classmethod
    def tearDownClass(cls):
        cbp.CHECK_ENDPOINT = cls.saved
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

    def ctx(self, request_url, offers):
        accepts = [types.SimpleNamespace(network=n, pay_to=p) for n, p in offers]
        return types.SimpleNamespace(request_url=request_url, payment_required=types.SimpleNamespace(accepts=accepts))

    def test_x402_hook_raises_on_avoid_with_the_requested_url(self):
        ctx = self.ctx(AVOID_URL, [("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "PayTo111")])
        with self.assertRaises(cbp.Vet402Avoid) as e:
            cbp.vet402_on_payment_required(ctx)
        self.assertIn("vet402: avoid.", str(e.exception))
        self.assertEqual(Mock.seen[-1], {"url": AVOID_URL, "chain": "solana", "payTo": "PayTo111"})

    def test_x402_hook_asks_once_per_offer(self):
        ctx = self.ctx(PAY_URL, [("eip155:8453", "0x1"), ("eip155:8453", "0x1"), ("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "So1")])
        self.assertIsNone(cbp.vet402_on_payment_required(ctx))
        self.assertEqual([q.get("chain") for q in Mock.seen], ["base", "solana"])

    def test_x402_hook_goes_on(self):
        for url in (PAY_URL, UNKNOWN_URL, "http://plain.example/"):
            self.assertIsNone(cbp.vet402_on_payment_required(self.ctx(url, [("eip155:8453", "0x1")])))
        self.assertIsNone(cbp.vet402_on_payment_required(types.SimpleNamespace(request_url="", payment_required=None)))

    def test_x402_hook_says_when_the_record_cannot_be_read(self):
        saved = cbp.CHECK_ENDPOINT
        err = io.StringIO()
        try:
            cbp.CHECK_ENDPOINT = "http://127.0.0.1:9/v1/check"
            with contextlib.redirect_stderr(err):
                self.assertIsNone(cbp.vet402_on_payment_required(self.ctx(AVOID_URL, [("eip155:8453", "0x1"), ("solana", "So1")])))
        finally:
            cbp.CHECK_ENDPOINT = saved
        self.assertTrue(err.getvalue().startswith(cbp.UNREADABLE), err.getvalue())
        self.assertEqual(err.getvalue().count("\n"), 1, "one line")

    def test_command_line_exit_codes(self):
        script = os.path.join(HERE, "check_before_paying.py")
        env = {**os.environ, "VET402_CHECK_ENDPOINT": self.endpoint}

        def run(*args):
            return subprocess.run([sys.executable, "-B", script, *args], env=env, capture_output=True, text=True, timeout=30)

        avoid = run(AVOID_URL)
        self.assertEqual(avoid.returncode, 1, avoid.stderr)
        self.assertTrue(avoid.stdout.startswith("vet402: avoid."))
        self.assertEqual(run(PAY_URL).returncode, 0)
        self.assertEqual(run(UNKNOWN_URL, "--chain", "base").returncode, 0)
        self.assertEqual(run("http://plain.example/").returncode, 2)
        self.assertEqual(run().returncode, 2)


try:
    import x402  # noqa: F401
    from x402.http import x402HTTPClientSync  # noqa: F401
    from x402.http.clients.requests import PaymentError, x402_requests  # noqa: F401

    HAVE_X402 = True
except ImportError:
    HAVE_X402 = False


@unittest.skipUnless(HAVE_X402, 'x402 is not installed (pip install "x402[requests]" to run this end to end)')
class RealX402ClientTest(unittest.TestCase):
    """The hook in the real x402 requests client: a local seller answers 402, a stub scheme stands in for the signer."""

    verdict = "avoid"

    @classmethod
    def setUpClass(cls):
        test = cls

        class Seller(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path.startswith("/v1/check"):
                    test.asked.append(dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query)))
                    if test.verdict == "down":
                        self.send_response(503)
                        self.end_headers()
                        return
                    body = json.dumps({"verdict": test.verdict, "why": "test"}).encode()
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if self.headers.get("PAYMENT-SIGNATURE"):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"paid")
                    return
                pr = {
                    "x402Version": 2,
                    "resource": {"url": "https://another-name.example/paid"},
                    "accepts": [{"scheme": "exact", "network": "eip155:8453", "asset": "0xA", "amount": "1000", "payTo": "0xabc", "maxTimeoutSeconds": 60, "extra": {}}],
                }
                self.send_response(402)
                self.send_header("PAYMENT-REQUIRED", base64.b64encode(json.dumps(pr).encode()).decode())
                self.end_headers()

        cls.asked = []
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Seller)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.saved = cbp.CHECK_ENDPOINT
        cbp.CHECK_ENDPOINT = cls.base + "/v1/check"

    @classmethod
    def tearDownClass(cls):
        cbp.CHECK_ENDPOINT = cls.saved
        cls.server.shutdown()
        cls.server.server_close()

    def session(self, signed):
        from x402 import x402ClientSync
        from x402.http import x402HTTPClientSync
        from x402.http.clients.requests import x402_requests

        class StubScheme:
            scheme = "exact"

            def create_payment_payload(self, requirements):
                signed.append(requirements)
                return {"signature": "0xstub"}

        client = x402ClientSync()
        client.set_spend_controls(False)
        client.register("eip155:8453", StubScheme())
        return x402_requests(x402HTTPClientSync(client).on_payment_required(cbp.vet402_on_payment_required))

    def test_avoid_raises_payment_error_and_nothing_is_signed(self):
        from x402.http.clients.requests import PaymentError

        type(self).verdict = "avoid"
        signed = []
        with self.assertRaises(PaymentError) as e:
            self.session(signed).get(self.base + "/paid")
        self.assertEqual(signed, [])
        self.assertIn("vet402: avoid.", str(e.exception))
        self.assertEqual(self.asked[-1]["url"], self.base + "/paid", "the requested URL, not the one the 402 names")

    def test_pay_unknown_and_down_go_on(self):
        for v in ("pay", "unknown", "down"):
            type(self).verdict = v
            signed = []
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                r = self.session(signed).get(self.base + "/paid")
            self.assertEqual((r.status_code, len(signed)), (200, 1), v)
            self.assertEqual(err.getvalue().startswith(cbp.UNREADABLE), v == "down", err.getvalue())


if __name__ == "__main__":
    unittest.main()
