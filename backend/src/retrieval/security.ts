import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SecurityValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SecurityValidationError';
  }
}

/**
 * Checks if an IPv4 address string falls into private, loopback, link-local,
 * multicast, carrier-grade NAT, or reserved address ranges.
 */
export function isProhibitedIPv4(ip: string): boolean {
  const rawParts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (rawParts.length !== 4 || rawParts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // Malformed IPv4 is prohibited
  }

  const [a, b, c, d] = rawParts as [number, number, number, number];

  // 0.0.0.0/8 (Current network / "This host on this network")
  if (a === 0) return true;
  // 10.0.0.0/8 (Private network)
  if (a === 10) return true;
  // 100.64.0.0/10 (Shared address space / Carrier-grade NAT: 100.64.0.0 - 100.127.255.255)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (Private network: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.168.0.0/16 (Private network)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Network benchmark tests: 198.18.0.0 - 198.19.255.255)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (Reserved / Future use: 240.0.0.0 - 255.255.255.254)
  // 255.255.255.255 (Broadcast)
  if (a >= 240) return true;

  return false;
}

/**
 * Checks if an IPv6 address string falls into loopback, unique-local, link-local,
 * multicast, or IPv4-mapped prohibited address ranges.
 */
export function isProhibitedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // ::1 (Loopback)
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  // :: (Unspecified)
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
  // IPv4-mapped IPv6 (::ffff:192.0.2.128 or ::ffff:c000:0280)
  // Check both dotted-decimal and hexadecimal IPv4 representations.
  const mappedMatch = normalized.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/);

  if (mappedMatch) {
    const mappedAddress = mappedMatch[1];

    if (mappedAddress === undefined) {
      return true;
    }

    if (mappedAddress.includes('.')) {
      return isProhibitedIPv4(mappedAddress);
    }

    // The final two 16-bit groups encode the four IPv4 octets.
    const hexGroups = mappedAddress.split(':');
    if (hexGroups.length === 2 && hexGroups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
      const highGroup = hexGroups[0];
      const lowGroup = hexGroups[1];

      if (highGroup === undefined || lowGroup === undefined) {
        return true;
      }

      const high = Number.parseInt(highGroup, 16);
      const low = Number.parseInt(lowGroup, 16);
      const ipv4 = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');

      return isProhibitedIPv4(ipv4);
    }

    // Fail closed for malformed IPv4-mapped representations.
    return true;
  }

  // fc00::/7 (Unique local address: fc00:: - fdff::)
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true;

  // fe80::/10 (Link-local: fe80:: - febf::)
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true;

  // ff00::/8 (Multicast)
  if (/^ff[0-9a-f]{2}:/i.test(normalized)) return true;

  // 2001:db8::/32 (Documentation)
  if (normalized.startsWith('2001:db8:')) return true;

  return false;
}

export function isProhibitedIP(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isProhibitedIPv4(ip);
  if (version === 6) return isProhibitedIPv6(ip);
  return true; // Not a valid IP
}

export type DestinationValidationOptions = {
  allowLocalTestDestinations?: boolean | undefined;
  dnsLookup?:
    | ((hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>)
    | undefined;
};

/**
 * Validates a destination URL against SSRF rules:
 * 1. Protocol must be http or https
 * 2. Ports must be standard (80 for http, 443 for https)
 * 3. No userinfo (credentials in URL)
 * 4. Hostname must not be localhost or local domain
 * 5. DNS resolution must not resolve to any prohibited IP addresses
 */
export async function validateDestination(
  rawUrl: string,
  options: DestinationValidationOptions = {},
): Promise<{ url: URL; resolvedIPs: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SecurityValidationError('Invalid destination URL format', 'INVALID_URL');
  }

  // Restrict protocols
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SecurityValidationError(
      `Unsupported protocol '${url.protocol}'; only http: and https: are permitted`,
      'PROHIBITED_PROTOCOL',
    );
  }

  // Reject credentials in URL
  if (url.username || url.password) {
    throw new SecurityValidationError(
      'URLs containing user credentials are not permitted',
      'USERINFO_NOT_PERMITTED',
    );
  }

  // Restrict ports
  const explicitPort = url.port ? Number.parseInt(url.port, 10) : null;
  const standardPort = url.protocol === 'https:' ? 443 : 80;
  if (explicitPort !== null && explicitPort !== standardPort) {
    if (!options.allowLocalTestDestinations) {
      throw new SecurityValidationError(
        `Non-standard port ${explicitPort} is prohibited for ${url.protocol}`,
        'PROHIBITED_PORT',
      );
    }
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    throw new SecurityValidationError('Missing hostname in URL', 'MISSING_HOSTNAME');
  }

  // Localhost checks
  const isLoopbackHost = hostname === 'localhost' || hostname.endsWith('.localhost');
  const isInternalDomain =
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.home.arpa');

  if (isInternalDomain || isLoopbackHost) {
    if (!(options.allowLocalTestDestinations && isLoopbackHost)) {
      throw new SecurityValidationError(
        `Destination hostname '${hostname}' is an internal domain`,
        'PROHIBITED_HOSTNAME',
      );
    }
  }

  // Check if hostname is an IP literal
  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) {
    const isLoopbackIp = hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
    if (!(options.allowLocalTestDestinations && isLoopbackIp) && isProhibitedIP(hostname)) {
      throw new SecurityValidationError(
        `Direct connection to private/reserved IP '${hostname}' is prohibited`,
        'PROHIBITED_IP',
      );
    }
    return { url, resolvedIPs: [hostname] };
  }

  // DNS resolution check
  if (!options.allowLocalTestDestinations) {
    let addresses: { address: string; family: number }[];
    try {
      const result = options.dnsLookup
        ? await options.dnsLookup(hostname, { all: true })
        : await lookup(hostname, { all: true });
      addresses = Array.isArray(result) ? result : [result];
    } catch {
      throw new SecurityValidationError(
        `DNS resolution failed for hostname '${hostname}'`,
        'DNS_LOOKUP_FAILED',
      );
    }

    if (!addresses || addresses.length === 0) {
      throw new SecurityValidationError(
        `No DNS records found for hostname '${hostname}'`,
        'NO_DNS_RECORDS',
      );
    }

    const resolvedIPs: string[] = [];
    for (const record of addresses) {
      resolvedIPs.push(record.address);
      if (isProhibitedIP(record.address)) {
        throw new SecurityValidationError(
          `Hostname '${hostname}' resolved to prohibited IP address '${record.address}'`,
          'PROHIBITED_RESOLVED_IP',
        );
      }
    }

    return { url, resolvedIPs };
  }

  return { url, resolvedIPs: ['127.0.0.1'] };
}
