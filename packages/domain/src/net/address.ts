import { isIP } from "node:net";

interface Ipv4Range {
  readonly network: readonly [number, number, number, number];
  readonly bits: number;
}

const BLOCKED_IPV4: readonly Ipv4Range[] = [
  { network: [0, 0, 0, 0], bits: 8 },
  { network: [10, 0, 0, 0], bits: 8 },
  { network: [100, 64, 0, 0], bits: 10 },
  { network: [127, 0, 0, 0], bits: 8 },
  { network: [169, 254, 0, 0], bits: 16 },
  { network: [172, 16, 0, 0], bits: 12 },
  { network: [192, 0, 0, 0], bits: 24 },
  { network: [192, 0, 2, 0], bits: 24 },
  { network: [192, 88, 99, 0], bits: 24 },
  { network: [192, 168, 0, 0], bits: 16 },
  { network: [198, 18, 0, 0], bits: 15 },
  { network: [198, 51, 100, 0], bits: 24 },
  { network: [203, 0, 113, 0], bits: 24 },
  { network: [224, 0, 0, 0], bits: 4 },
  { network: [240, 0, 0, 0], bits: 4 },
];

function ipv4Number(address: string): number {
  const [a = 0, b = 0, c = 0, d = 0] = address.split(".").map(Number);
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0) as number;
}

function inIpv4Range(address: string, range: Ipv4Range): boolean {
  const value = ipv4Number(address);
  const network = ipv4Number(range.network.join("."));
  const mask = range.bits === 0 ? 0 : (0xffff_ffff << (32 - range.bits)) >>> 0;
  return (value & mask) >>> 0 === (network & mask) >>> 0;
}

function isBlockedIpv4(address: string): boolean {
  return BLOCKED_IPV4.some((range) => inIpv4Range(address, range));
}

function expandIpv6(address: string): number[] | null {
  let value = address.split("%")[0]?.toLowerCase() ?? "";

  if (value.includes(".")) {
    const colon = value.lastIndexOf(":");
    const embedded = value.slice(colon + 1);
    const octets = embedded.split(".").map(Number);

    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return null;
    }

    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    value = `${value.slice(0, colon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = value.split("::");

  if (halves.length > 2) {
    return null;
  }

  const parse = (group: string): number | null =>
    /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : null;

  if (halves.length === 2) {
    const left = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
    const right = halves[1] === "" ? [] : (halves[1] ?? "").split(":");
    const fill = 8 - left.length - right.length;

    if (fill < 0) {
      return null;
    }

    const groups = [...left, ...Array<string>(fill).fill("0"), ...right].map(parse);

    return groups.some((group) => group === null) ? null : (groups as number[]);
  }

  const groups = value.split(":").map(parse);
  return groups.length !== 8 || groups.some((group) => group === null)
    ? null
    : (groups as number[]);
}

function isBlockedIpv6(address: string): boolean {
  const groups = expandIpv6(address);

  if (groups === null) {
    return true;
  }

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;

  // All IPv4-mapped and IPv4-compatible forms are rejected, even when the embedded
  // address looks public: they are a known bypass class (ADR 0016).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return true;
  }

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return true;
  }

  if ((g0 & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique local
  }

  if ((g0 & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }

  if ((g0 & 0xff00) === 0xff00) {
    return true; // ff00::/8 multicast
  }

  if (g0 === 0x64 && g1 === 0xff9b) {
    return true; // NAT64
  }

  if (g0 === 0x2002) {
    return true; // 6to4, which embeds IPv4
  }

  if (g0 === 0x2001 && (g1 === 0xdb8 || g1 === 0x2 || (g1 & 0xfff0) === 0x10)) {
    return true; // documentation, benchmarking and ORCHID
  }

  if ((g0 & 0xfff0) === 0x3ff0) {
    return true; // 3fff::/20 documentation
  }

  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return true; // 100::/64 discard-only
  }

  return false;
}

/** Blocks every non-public destination class in ADR 0016; unknown input fails closed. */
export function isBlockedAddress(address: string): boolean {
  const plain = address.replace(/^\[|\]$/g, "");
  const family = isIP(plain);

  if (family === 4) {
    return isBlockedIpv4(plain);
  }

  if (family === 6) {
    return isBlockedIpv6(plain);
  }

  return true;
}
