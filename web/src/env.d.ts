interface ImportMetaEnv {
	readonly PUBLIC_CF_WEB_ANALYTICS_TOKEN?: string;
}

declare module 'cloudflare:workers' {
	export const env: { LIVE: import('./storms/search-store').SearchBucket };
}
