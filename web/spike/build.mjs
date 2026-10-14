/* global URL */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const astroRequire = createRequire(require.resolve('astro'));
const viteRequire = createRequire(astroRequire.resolve('vite'));
const { build } = viteRequire('esbuild');
const out = new URL('../dist/spike/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('index.html', out), '<html><body style="margin:0;background:black"><script type="module" src="./bench.js"></script></body></html>');
await build({ entryPoints: [new URL('./bench.ts', import.meta.url).pathname], bundle: true, format: 'esm', outfile: new URL('bench.js', out).pathname });
