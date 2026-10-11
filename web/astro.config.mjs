// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';
import { buildInfo } from './scripts/build-info.mjs';

// https://astro.build/config
export default defineConfig({
	site: 'https://scintille.app',
	adapter: cloudflare({ imageService: 'passthrough' }),
	session: false,
	vite: { define: { __SCINTILLE_BUILD__: JSON.stringify(buildInfo()) } },
	integrations: [sitemap({ filter: (page) => !page.endsWith('/render/') })],
});
