// Checks every built page has a unique title, description and canonical URL,
// and that robots.txt, llms.txt and the sitemap are built.
import { access, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import process from 'node:process';

const DIST = join(import.meta.dirname, '..', 'dist', 'client');
const SITE = 'https://scintille.app/';

async function htmlFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((e) => {
			const path = join(dir, e.name);
			if (e.isDirectory()) return htmlFiles(path);
			return e.name.endsWith('.html') ? [path] : [];
		}),
	);
	return nested.flat();
}

function attr(tag, name) {
	return tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1];
}

function extract(html) {
	const titles = [...html.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1].trim());
	const tags = html.match(/<(meta|link)\b[^>]*>/gi) ?? [];
	const descriptions = tags.filter((t) => attr(t, 'name') === 'description').map((t) => attr(t, 'content')?.trim());
	const canonicals = tags.filter((t) => attr(t, 'rel') === 'canonical').map((t) => attr(t, 'href')?.trim());
	return { title: titles, description: descriptions, canonical: canonicals };
}

const files = await htmlFiles(DIST);
const errors = [];
const seen = { title: new Map(), description: new Map(), canonical: new Map() };

if (files.length === 0) errors.push(`no HTML files found in ${DIST}`);

for (const file of files) {
	const page = relative(DIST, file);
	const fields = extract(await readFile(file, 'utf8'));
	for (const [field, values] of Object.entries(fields)) {
		if (values.length !== 1 || !values[0]) {
			errors.push(`${page}: expected exactly one non-empty ${field}, found ${values.length}`);
			continue;
		}
		const value = values[0];
		if (field === 'canonical' && !value.startsWith(SITE)) {
			errors.push(`${page}: canonical "${value}" is not an absolute URL on ${SITE}`);
		}
		const other = seen[field].get(value);
		if (other) errors.push(`${page}: ${field} "${value}" duplicates ${other}`);
		else seen[field].set(value, page);
	}
}

const SITEMAP = 'sitemap-index.xml';
for (const name of [SITEMAP, 'sitemap-0.xml', 'llms.txt']) {
	await access(join(DIST, name)).catch(() => errors.push(`${name} is missing`));
}
const robots = await readFile(join(DIST, 'robots.txt'), 'utf8').catch(() => null);
if (robots === null) errors.push('robots.txt is missing');
else if (!robots.split('\n').some((l) => l.trim() === `Sitemap: ${SITE}${SITEMAP}`)) {
	errors.push(`robots.txt does not reference ${SITE}${SITEMAP}`);
}

if (errors.length > 0) {
	process.stderr.write(`SEO check failed:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
	process.exitCode = 1;
} else {
	process.stdout.write(`SEO check passed for ${files.length} page(s).\n`);
}
