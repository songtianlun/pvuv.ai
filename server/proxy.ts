import { BlockList, isIP } from "node:net";

function normalize(address: string) {
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4)
    return address.slice(7);
  return address;
}

/** Explicit peer/hop allowlist for standard X-Forwarded-For proxies. */
export class TrustedProxies {
  private ranges = new BlockList();

  constructor(cidrs = "") {
    for (const entry of cidrs.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [address, prefix, extra] = entry.split("/");
      const family = isIP(address);
      const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix);
      if (!family || extra !== undefined || (prefix !== undefined && !/^\d+$/.test(prefix)) ||
          !Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128))
        throw new Error(`Invalid TRUSTED_PROXY_CIDRS entry: ${entry}`);
      this.ranges.addSubnet(address, bits, family === 4 ? "ipv4" : "ipv6");
    }
  }

  trusts(address: string) {
    address = normalize(address);
    const family = isIP(address);
    return !!family && this.ranges.check(address, family === 4 ? "ipv4" : "ipv6");
  }

  clientIP(peer: string, forwardedFor?: string) {
    peer = normalize(peer);
    if (!this.trusts(peer) || !forwardedFor) return peer;
    const hops = forwardedFor.split(",").map((s) => normalize(s.trim()));
    if (hops.length > 32 || hops.some((hop) => !isIP(hop))) return peer;
    // Walk from the connected proxy towards the client. Ignore all entries
    // to the left of the first untrusted hop (which may be client-supplied).
    let address = peer;
    for (const hop of hops.reverse()) {
      if (!this.trusts(address)) break;
      address = hop;
    }
    return address;
  }
}
