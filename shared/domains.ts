/**
 * Entries of a site's allowed_domains whitelist. Three forms:
 *   example.com    the domain and all its subdomains
 *   *.example.com  subdomains only, not example.com itself
 *   *              any origin
 */

/** Canonical form of a user-typed entry, or null when it isn't valid. */
export function normalizeDomain(raw: unknown): string | null {
  const d = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (d === '*') return d;
  return /^[a-z0-9.-]+$/.test(d.replace(/^\*\./, '')) ? d : null;
}

/** Does a lowercase host match a whitelist entry? */
export function hostMatches(host: string, entry: string): boolean {
  if (entry === '*') return true;
  if (entry.startsWith('*.')) return host.endsWith(entry.slice(1));
  return host === entry || host.endsWith(`.${entry}`);
}

/** Does a host belong to the site that lists this entry? Same as hostMatches
 *  except for `*`: accepting events from anywhere doesn't make every host on
 *  the web the site's own, and treating it so would erase all external sources. */
export function hostOwned(host: string, entry: string): boolean {
  return entry !== '*' && hostMatches(host, entry);
}
