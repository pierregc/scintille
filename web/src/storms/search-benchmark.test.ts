import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { searchCatalog, type SearchBucket } from './search-store';

it.skipIf(!process.env.SCINTILLE_SEARCH_BENCH)('measures synthetic query batches against disk objects', async () => {
	const directory = process.env.SCINTILLE_SEARCH_BENCH;
	const bucket: SearchBucket = { async get(path) {
		try {
			const bytes = await readFile(`${directory}/${path}`);
			return { size: bytes.length, body: new Response(bytes).body as ReadableStream<Uint8Array> };
		} catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
	} };
	const samples: Record<string, unknown>[] = [];
	for (const [name, query] of [ ['open', ''], ['old-place', 'q=place99&to=2026-10-17'], ['combined', 'region=north-america&level=4&from=2026-10-01'], ['sparse', 'q=region1&level=1'] ]) {
		const latencies: number[] = [];
		let sample: Record<string, unknown> = {};
		for (let i = 0; i < 20; i++) {
			const metrics = { reads: 0, bytes: 0, candidates: 0 };
			const start = performance.now();
			const result = await searchCatalog(bucket, new URLSearchParams(query), Date.parse('2026-10-18T12:00:00Z'), metrics);
			latencies.push(performance.now() - start);
			const body = JSON.stringify(result);
			expect(Buffer.byteLength(body)).toBeLessThanOrEqual(65536);
			expect(metrics.reads).toBeLessThanOrEqual(36);
			expect(metrics.candidates).toBeLessThanOrEqual(256);
			sample = { query: name, results: result.storms.length, exhausted: result.exhausted, decoded_bytes: Buffer.byteLength(body), gzip_bytes: gzipSync(body).byteLength, ...metrics };
		}
		latencies.sort((a, b) => a - b);
		samples.push({ ...sample, local_disk_p95_ms: +latencies[18].toFixed(3) });
	}
	await writeFile(`${directory}/query-measurements.json`, JSON.stringify(samples, null, 2));
	console.log(JSON.stringify(samples));
}, 60000);
