"""Run by packages/check/test/examples.test.ts with VET402_CHECK_ENDPOINT on a loopback /v1/check."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vet402_tool  # noqa: E402

AVOID = "https://api.xona-agent.com/token/pumpfun-trending"
UNKNOWN = "https://nobody.example/paid"


class Vet402ToolTest(unittest.TestCase):
    def test_tool_says_the_verdict(self):
        fn = getattr(vet402_tool.check_x402_seller, "func", vet402_tool.check_x402_seller)
        self.assertTrue(fn(AVOID).startswith("verdict: avoid. vet402 paid this seller "))
        self.assertTrue(fn(UNKNOWN).startswith("verdict: unknown."))

    def test_pay_after_check(self):
        paid = []
        self.assertIsNone(vet402_tool.pay_after_check(AVOID, paid.append))
        vet402_tool.pay_after_check(UNKNOWN, paid.append)
        self.assertEqual(paid, [UNKNOWN])

    def test_tool_wrapper_when_langchain_is_present(self):
        name = getattr(vet402_tool.check_x402_seller, "name", None)
        if os.environ.get("EXPECT_LANGCHAIN_STUB"):
            self.assertEqual(name, "check_x402_seller")


if __name__ == "__main__":
    unittest.main()
