import { test } from "node:test";
import assert from "node:assert/strict";
import { TrustedProxies } from "../proxy";

test("forwarding is disabled by default and cannot be enabled by request headers", () => {
  const empty = new TrustedProxies();
  assert.equal(empty.clientIP("10.42.0.7", "203.0.113.9"), "10.42.0.7");
  const proxies = new TrustedProxies("10.42.0.0/16");
  assert.equal(proxies.clientIP("198.51.100.7", "203.0.113.9"), "198.51.100.7");
});

test("Traefik forwarding ignores forged entries before the closest untrusted client", () => {
  const proxies = new TrustedProxies("10.42.0.0/16");
  assert.equal(proxies.clientIP("10.42.0.7", "192.0.2.66, 203.0.113.9"), "203.0.113.9");
  assert.equal(proxies.clientIP("10.42.0.7", "203.0.113.9, 10.42.0.8"), "203.0.113.9");
  assert.equal(proxies.clientIP("10.42.0.7", "203.0.113.9, 198.51.100.8"), "198.51.100.8");
  const chain = new TrustedProxies("10.42.0.0/16,198.51.100.8/32");
  assert.equal(chain.clientIP("10.42.0.7", "192.0.2.66, 203.0.113.9, 198.51.100.8"), "203.0.113.9");
});

test("IPv6 and IPv4-mapped IPv6 peers work with explicit proxy ranges", () => {
  const proxies = new TrustedProxies("10.42.0.0/16,2001:db8:42::/48");
  assert.equal(proxies.clientIP("::ffff:10.42.0.7", "203.0.113.9"), "203.0.113.9");
  assert.equal(proxies.clientIP("2001:db8:42::7", "2001:db8:1::9"), "2001:db8:1::9");
  assert.equal(proxies.clientIP("::ffff:198.51.100.7", "203.0.113.9"), "198.51.100.7");
});

test("malformed or excessive forwarding chains fall back to the connected peer", () => {
  const proxies = new TrustedProxies("10.42.0.0/16");
  for (const header of ["", "unknown", "203.0.113.9,", "203.0.113.9:1234", Array(33).fill("10.42.0.8").join(",")])
    assert.equal(proxies.clientIP("10.42.0.7", header), "10.42.0.7");
});

test("invalid trusted-proxy configuration fails at startup", () => {
  for (const value of ["unknown", "10.42.0.0/33", "::/129", "127.0.0.1/", "127.0.0.1/1/2"])
    assert.throws(() => new TrustedProxies(value), /Invalid TRUSTED_PROXY_CIDRS/);
});
