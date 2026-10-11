// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
	site: 'https://scintille.app',
	adapter: cloudflare({ imageService: 'passthrough' }),
	session: false,
	integrations: [sitemap({ filter: (page) => !page.endsWith('/render/') })],
});
