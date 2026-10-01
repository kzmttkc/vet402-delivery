import assert from "node:assert/strict";
import { test } from "node:test";
import { rateKeyOfIp } from "../src/proxy-buy/handler.js";

test("rate limits: one IPv6 client per /64, IPv4 per address", () => {
  assert.equal(rateKeyOfIp("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(rateKeyOfIp("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
  assert.equal(rateKeyOfIp("[2001:db8:1:2::9]"), "2001:db8:1:2::/64");
  assert.equal(rateKeyOfIp("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(rateKeyOfIp("203.0.113.7"), "203.0.113.7");
  assert.equal(rateKeyOfIp("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(rateKeyOfIp("unknown"), "unknown");
  assert.notEqual(rateKeyOfIp("2001:db8:1:2::1"), rateKeyOfIp("2001:db8:1:3::1"));
});
