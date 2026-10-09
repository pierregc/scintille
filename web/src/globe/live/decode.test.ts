import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { LiveManifest } from '../../contract/types';
import { CHUNK_SCALES, ChunkFormatError, decodeChunk, fetchChunk } from './decode';
import { encodeChunk } from './testing';

const FIXTURES = new URL('../../../../fixtures/live/', import.meta.url);

const fixtureFetch: typeof fetch = async (input) => new Response(await readFile(new URL(String(input), FIXTURES)));

describe('decodeChunk', () => {
	it('decodes a fixture chunk like the reference decoder', async () => {
		const manifest = JSON.parse(await readFile(new URL('manifest.json', FIXTURES), 'utf8')) as LiveManifest;
		const ref = manifest.chunks[0];
		const chunk = await fetchChunk(ref.path, fixtureFetch);
		expect(chunk.count).toBe(ref.flash_count);
		expect(chunk.start).toBe(Date.parse(ref.start));
		const first = chunk.start + chunk.columns.event_offset_ms[0];
		const last = chunk.start + chunk.columns.event_offset_ms[chunk.count - 1];
		expect(first).toBe(Date.parse(ref.event_min ?? ''));
		expect(last).toBe(Date.parse(ref.event_max ?? ''));
		for (let i = 0; i < chunk.count; i++) {
			expect(Math.abs(chunk.columns.lat[i] * CHUNK_SCALES.lat)).toBeLessThanOrEqual(90);
			expect(chunk.columns.source[i]).toBeLessThan(3);
		}
	});

	it('reads columns at their offsets', () => {
		const bytes = encodeChunk(1_784_138_400, [
			{ offsetMs: -1500, lat: 45, lon: -120 },
			{ offsetMs: -20, lat: -10, lon: 30 },
		]);
		const chunk = decodeChunk(bytes.buffer);
		expect(chunk.start).toBe(1_784_138_400_000);
		expect([...chunk.columns.event_offset_ms]).toEqual([-1500, -20]);
		expect(chunk.columns.lat[0] * CHUNK_SCALES.lat).toBeCloseTo(45, 2);
		expect(chunk.columns.lon[1] * CHUNK_SCALES.lon).toBeCloseTo(30, 2);
		expect([...chunk.columns.source]).toEqual([0, 1]);
	});

	it('rejects another major version', () => {
		const bytes = encodeChunk(0, [{ offsetMs: 0, lat: 0, lon: 0 }], 3);
		expect(() => decodeChunk(bytes.buffer)).toThrow(ChunkFormatError);
	});

	it('rejects bad magic and truncated chunks', () => {
		const bytes = encodeChunk(0, [{ offsetMs: 0, lat: 0, lon: 0 }]);
		expect(() => decodeChunk(bytes.buffer.slice(0, bytes.byteLength - 1))).toThrow(ChunkFormatError);
		bytes[0] = 0;
		expect(() => decodeChunk(bytes.buffer)).toThrow(ChunkFormatError);
	});
});
