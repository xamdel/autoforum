import { BlockList } from "node:net";

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(network, prefix, "ipv4");

for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["fc00::", 7], ["fe80::", 10],
  ["ff00::", 8], ["2001:db8::", 32],
] as const) blockedV6.addSubnet(network, prefix, "ipv6");

/** Shared outbound-network policy: only ordinary public Internet addresses are allowed. */
export function isPublicAddress(address: string, family: 4 | 6): boolean {
  return family === 4
    ? !blockedV4.check(address, "ipv4")
    : !blockedV6.check(address, "ipv6");
}
