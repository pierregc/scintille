/** Cloudflare Web Analytics beacon config, or null when the token is missing or malformed. */
export function beaconConfig(token: string | undefined): string | null {
	const t = token?.trim();
	if (!t || !/^[0-9a-f]{32}$/i.test(t)) return null;
	return JSON.stringify({ token: t });
}

export const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
