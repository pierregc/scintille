import { describe, expect, it } from 'vitest';
import { COLD_TOPS, createColdTops, glowStrength, parseColdTops } from './cold-tops';

const state = (frames: { a: string | null; b: string | null; mix: number } | null) => ({
	frames,
	wallMs: 0,
	sun: [1, 0, 0] as const,
	steady: false,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('cold tops', () => {
	it('parses rows and rejects anything else', () => {
		expect(Array.from(parseColdTops({ tops: [[12.5, 110, 0.5, 205]] }))).toEqual([12.5, 110, 0.5, 205]);
		expect(() => parseColdTops({ tops: [[12.5, 110, 0.5]] })).toThrow();
		expect(() => parseColdTops({ tops: [[12.5, 110, 0.5, 'x']] })).toThrow();
		expect(() => parseColdTops({})).toThrow();
	});

	it('glows more for colder, fuller cells', () => {
		expect(glowStrength(1, 195)).toBe(1);
		expect(glowStrength(1, 214)).toBeLessThan(glowStrength(1, 200));
		expect(glowStrength(0.25, 200)).toBeLessThan(glowStrength(1, 200));
		expect(glowStrength(0, 200)).toBe(0);
	});

	it('crossfades the cells of the two frames shown', async () => {
		const rows: Record<string, number[]> = { a: [10, 100, 1, 200], b: [11, 101, 1, 200, -5, 120, 0.5, 210] };
		const layer = createColdTops({ load: async (url) => new Float32Array(rows[url]) });
		layer.update(state({ a: 'a', b: 'b', mix: 0.25 }));
		expect(layer.mesh.visible).toBe(false);
		await flush();
		layer.update(state({ a: 'a', b: 'b', mix: 0.25 }));
		expect(layer.mesh.visible).toBe(true);
		const glow = layer.mesh.geometry.getAttribute('glow');
		expect(glow.count).toBe(3);
		expect((layer.mesh.geometry as unknown as { instanceCount: number }).instanceCount).toBe(3);
		expect([glow.getZ(0), glow.getZ(1), glow.getZ(2)]).toEqual([0, 1, 1]);
		const material = layer.mesh.material as unknown as { uniforms: Record<string, { value: number }> };
		expect(material.uniforms.mixB.value).toBe(0.25);
		const radius = Math.hypot(...layer.mesh.geometry.getAttribute('center').array.slice(0, 3));
		expect(radius).toBeCloseTo(1 + COLD_TOPS.heightKm / 6371, 6);
		layer.dispose();
	});

	it('hides without frames near the scene time and tolerates a missing file', async () => {
		const layer = createColdTops({ load: async () => { throw new Error('404'); } });
		layer.update(state({ a: 'a', b: 'a', mix: 0 }));
		await flush();
		layer.update(state({ a: 'a', b: 'a', mix: 0 }));
		expect(layer.mesh.visible).toBe(false);
		layer.update(state(null));
		expect(layer.mesh.visible).toBe(false);
		layer.dispose();
	});
});
