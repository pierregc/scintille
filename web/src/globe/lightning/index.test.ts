import { AdditiveBlending, CustomBlending, InstancedBufferGeometry, Mesh, PerspectiveCamera, ShaderMaterial, type WebGLRenderer } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeChunk } from '../live/decode';
import { FlashRing } from '../live/ring';
import { encodeChunk } from '../live/testing';
import { NO_DELAY } from '../live/delay';
import { DENSITY, heroLot, heroShare } from './density';
import { CHANNEL, flashSeed } from './channel';
import { aliveCount, aliveLoad, budgetStart, createLightning, lightWindow, sampleCount } from './index';
import { FlashPlayback } from './playback';
import { flickerLength, PROFILE } from './profile';
import { MAX_SEGMENTS } from './skeleton';

/** A playback that has played at `speed` up to `now`. */
function playbackAt(now: number, speed: number): FlashPlayback {
	const playback = new FlashPlayback();
	playback.update(now, speed);
	return playback;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('3D channel integration', () => {
	it('shares bloom layers and retires channels while the afterglow remains', () => {
		const ring = new FlashRing(8);
		ring.push(decodeChunk(encodeChunk(100, [{ offsetMs: 0, lat: 0, lon: 0 }]).buffer));
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		const child = lightning.mesh.children[0];
		expect(child).toBeInstanceOf(Mesh);
		if (!(child instanceof Mesh)) throw new Error('missing channel mesh');
		lightning.mesh.layers.enable(1);
		expect(child.layers.mask).toBe(lightning.mesh.layers.mask);
		lightning.setTime(100_100);
		expect(child.geometry.instanceCount).toBe(MAX_SEGMENTS);
		const halo = lightning.mesh.children[1];
		if (!(halo instanceof Mesh)) throw new Error('missing halo');
		expect(halo.geometry).toBe(child.geometry);
		expect(halo.visible).toBe(true);
		expect(halo.layers.mask).toBe(lightning.mesh.layers.mask);
		lightning.setTime(101_000);
		expect(child.geometry.instanceCount).toBe(0);
		if (!(lightning.mesh.geometry instanceof InstancedBufferGeometry)) throw new Error('missing glow geometry');
		expect(lightning.mesh.geometry.instanceCount).toBe(1);
		const disposed = vi.fn();
		child.geometry.addEventListener('dispose', disposed);
		lightning.dispose();
		expect(disposed).toHaveBeenCalledOnce();
	});

	it('budgets the halo during a burst and builds no channel too far away to read', () => {
		const ring = new FlashRing(1024);
		ring.push(decodeChunk(encodeChunk(100, Array.from({ length: 300 }, (_, i) => ({ offsetMs: 0, lat: (i % 60) * 0.5, lon: Math.floor(i / 60) }))).buffer));
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		let wall = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => (wall += 100));
		for (let frame = 0; frame < 16; frame++) lightning.setTime(100_100);
		const halo = lightning.mesh.children[1];
		if (!(halo instanceof Mesh) || !(halo.material instanceof ShaderMaterial)) throw new Error('missing halo');
		expect(halo.material.uniforms.haloStrength.value).toBe(0);
		expect(halo.visible).toBe(false);
		lightning.viewKmPerPx = 12;
		lightning.setTime(100_100);
		expect(halo.geometry.instanceCount).toBe(0);
		lightning.dispose();
	});

	it('shares the reduced-motion profile uniform and cleans up its listener', () => {
		const preference = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
		vi.stubGlobal('matchMedia', () => preference);
		const lightning = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 0 });
		const child = lightning.mesh.children[0];
		if (!(child instanceof Mesh) || !(child.material instanceof ShaderMaterial)) throw new Error('missing channel material');
		expect(child.material.uniforms.flicker.value).toBe(0);
		const applyMotion = preference.addEventListener.mock.calls[0][1] as () => void;
		preference.matches = false;
		applyMotion();
		expect(child.material.uniforms.flicker.value).toBe(1);
		lightning.dispose();
		expect(preference.removeEventListener).toHaveBeenCalledWith('change', applyMotion);
	});

	it('keeps channels for their flicker in wall clock time while replaying fast', () => {
		const ring = new FlashRing(8);
		ring.push(decodeChunk(encodeChunk(100, [{ offsetMs: 0, lat: 0, lon: 0 }]).buffer));
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		const channel = lightning.mesh.children[0];
		if (!(channel instanceof Mesh)) throw new Error('missing channel mesh');
		lightning.setTime(100_000, undefined, 60);
		lightning.setTime(106_000, undefined, 60);
		expect(channel.geometry.instanceCount).toBe(MAX_SEGMENTS);
		lightning.setTime(130_000, undefined, 60);
		expect(channel.geometry.instanceCount).toBe(0);
		lightning.dispose();
	});
});

describe('storm view', () => {
	it('shows each flash alone without forgetting the afterglow chosen for the globe', () => {
		const lightning = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 0 });
		const material = lightning.mesh.material as ShaderMaterial;
		lightning.setDisplayMinutes(30);
		expect(material.uniforms.duration.value).toBe(1800);
		lightning.stormView = true;
		expect(lightning.displayMinutes).toBe(30);
		expect(material.uniforms.duration.value).toBe(0);
		expect(material.blending).toBe(CustomBlending);
		lightning.stormView = false;
		expect(material.uniforms.duration.value).toBe(1800);
		expect(material.blending).toBe(AdditiveBlending);
		lightning.dispose();
	});
});

describe('storm view budget', () => {
	it('finds where the newest flashes played by now begin', () => {
		const ring = new FlashRing(16);
		ring.push(decodeChunk(encodeChunk(100, [0, 100, 200, 300, 400].map((offsetMs) => ({ offsetMs, lat: 0, lon: 0 }))).buffer));
		expect(budgetStart(ring, 100_350, 2)).toBe(100_200);
		expect(budgetStart(ring, 100_350, 4)).toBe(Number.NEGATIVE_INFINITY);
		expect(budgetStart(ring, 100_400, 4)).toBe(100_100);
		expect(budgetStart(ring, 100_400, Infinity)).toBe(Number.NEGATIVE_INFINITY);
	});

	it('counts the flashes played within a span of scene time', () => {
		const ring = new FlashRing(16);
		ring.push(decodeChunk(encodeChunk(100, [0, 100, 200, 300, 400].map((offsetMs) => ({ offsetMs, lat: 0, lon: 0 }))).buffer));
		expect(aliveCount(ring, 100_400, 250)).toBe(3);
		expect(aliveCount(ring, 100_350, 51)).toBe(1);
		expect(aliveCount(ring, 100_350, 50)).toBe(0);
		expect(aliveCount(ring, 99_000, 1000)).toBe(0);
		expect(aliveCount(ring, 200_000, 1e6)).toBe(5);
	});

	it('weighs each flash alive by its flicker and fade over the window', () => {
		const ring = new FlashRing(16);
		ring.push(decodeChunk(encodeChunk(100, [0, 100, 200].map((offsetMs) => ({ offsetMs, lat: 0, lon: 0 }))).buffer));
		[100, 500, 5000].forEach((ms, i) => { ring.durationMs[ring.slot(i)] = ms; });
		const life = (ms: number) => flickerLength(ms) + CHANNEL.fade;
		expect(aliveLoad(ring, 100_200, 150, 0.4)).toBeCloseTo((life(500) + life(5000)) / 0.4, 9);
		expect(aliveLoad(ring, 100_200, 150, 0.4)).toBeCloseTo((0.65 + PROFILE.maxFlicker + 0.15) / 0.4, 9);
		expect(aliveLoad(ring, 100_200, 1000, 1)).toBeCloseTo(life(100) + life(500) + life(5000), 9);
		expect(aliveLoad(ring, 99_000, 1000, 0.4)).toBe(0);
	});
});

describe('sampleCount', () => {
	it('counts the flashes within their flicker or fade, and those under the share', () => {
		const ring = new FlashRing(16);
		ring.push(decodeChunk(encodeChunk(100, [0, 100, 200, 300, 400].map((offsetMs) => ({ offsetMs, lat: offsetMs / 100, lon: 0 }))).buffer));
		[100, 100, 900, 100, 100].forEach((ms, i) => { ring.durationMs[ring.slot(i)] = ms; });
		const life = (ms: number) => (flickerLength(ms) + CHANNEL.fade) * 1000;
		expect(sampleCount(ring, 100_000 + life(100) + 50, playbackAt(0, 1), NO_DELAY, 1)).toEqual({ alive: 3, drawn: 3 });
		expect(sampleCount(ring, 100_200 + life(900) - 1, playbackAt(0, 1), NO_DELAY, 1)).toEqual({ alive: 1, drawn: 1 });
		expect(sampleCount(ring, 100_400, playbackAt(0, 600), NO_DELAY, 1)).toEqual({ alive: 5, drawn: 5 });
		const lots = Array.from({ length: 5 }, (_, i) => { const s = ring.slot(i); return heroLot(flashSeed(ring.time[s], ring.lat[s], ring.lon[s]), ring.intensity[s]); });
		const share = [...lots].sort((a, b) => a - b)[2];
		expect(sampleCount(ring, 100_400, playbackAt(0, 600), NO_DELAY, share)).toEqual({ alive: 5, drawn: 2 });
	});
});

describe('storm view sample', () => {
	/** 2,000 flashes of one instrument over 240 s of scene time, then 200 over the next 240 s. */
	const burst = () => {
		const ring = new FlashRing(4096);
		const flashes = [
			...Array.from({ length: 2000 }, (_, i) => ({ offsetMs: i * 120, lat: (i % 50) * 0.1, lon: Math.floor(i / 50) * 0.1, source: 0 })),
			...Array.from({ length: 200 }, (_, i) => ({ offsetMs: 240_000 + i * 1200, lat: (i % 50) * 0.1, lon: 5 + Math.floor(i / 50) * 0.1, source: 0 })),
		];
		ring.push(decodeChunk(encodeChunk(100, flashes).buffer));
		return ring;
	};

	it('draws a share of the flashes sized for the replay speed and lifts the newest-flashes cap', () => {
		const ring = burst();
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		const material = lightning.mesh.material as ShaderMaterial;
		lightning.stormView = true;
		lightning.setTime(340_000, undefined, 600);
		const alive = aliveLoad(ring, 340_000, 240_000, DENSITY.aliveWindow);
		const wanted = heroShare(20, alive);
		expect(alive).toBeCloseTo((2000 * (flickerLength(ring.durationMs[ring.slot(0)]) + CHANNEL.fade)) / DENSITY.aliveWindow, 6);
		expect(alive).toBeGreaterThan(500);
		expect(lightning.stats.load).toBeCloseTo(alive, 9);
		expect(lightning.stats.target).toBe(20);
		expect(lightning.heroShare).toBeCloseTo(wanted, 9);
		expect(material.uniforms.heroShare.value).toBe(lightning.heroShare);
		expect(material.uniforms.budgetFrom.value).toBe(-1e6);
		const { alive: all, drawn } = lightning.stats;
		expect(all).toBe(sampleCount(ring, 340_000, playbackAt(340_000, 600), NO_DELAY, 1).alive);
		expect(drawn).toBe(sampleCount(ring, 340_000, playbackAt(340_000, 600), NO_DELAY, lightning.heroShare).drawn);
		expect(drawn).toBeGreaterThan(5);
		expect(drawn).toBeLessThan(60);
		lightning.setTime(340_000, undefined, 600);
		expect(lightning.stats.channels).toBe(sampleCount(ring, 340_000, playbackAt(340_000, 600), NO_DELAY, lightning.heroShare * DENSITY.edge).drawn);
		expect(lightning.stats.channels).toBeLessThanOrEqual(drawn * 1.2);
		lightning.dispose();
	});

	it('draws every flash at 1× and outside storm views, where the newest-flashes cap applies', () => {
		const ring = burst();
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		const material = lightning.mesh.material as ShaderMaterial;
		lightning.setTime(340_000, undefined, 600);
		expect(lightning.heroShare).toBe(1);
		expect(material.uniforms.budgetFrom.value).toBe(-1e6);
		lightning.stormView = true;
		lightning.setTime(340_000, undefined, 1);
		expect(lightning.heroShare).toBe(1);
		expect(lightning.stats.target).toBe(Infinity);
		expect(lightning.stats.drawn).toBe(lightning.stats.alive);
		expect(lightning.stats.alive).toBeGreaterThan(0);
		expect(material.uniforms.budgetFrom.value).toBeCloseTo((budgetStart(ring, 340_000, 500) - 340_000) / 1000, 6);
		lightning.dispose();
	});

	it('follows a changing rate over the smoothing time and jumps on a seek', () => {
		const ring = burst();
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		let wall = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => wall);
		lightning.stormView = true;
		lightning.setTime(340_000, undefined, 600);
		const dense = lightning.heroShare;
		const alive0 = lightning.stats.load;
		const shares: number[] = [];
		for (let frame = 1; frame <= 120; frame++) {
			wall += 1000 / 60;
			lightning.setTime(340_000 + frame * 10_000, undefined, 600);
			shares.push(lightning.heroShare);
		}
		const sparse = heroShare(20, lightning.stats.load);
		expect(lightning.stats.load).toBeLessThan(alive0);
		for (let i = 1; i < shares.length; i++) {
			expect(shares[i]).toBeGreaterThanOrEqual(shares[i - 1]);
			expect(shares[i] / shares[i - 1]).toBeLessThanOrEqual((sparse / dense) ** (1 / 60 / DENSITY.smoothing) + 1e-9);
		}
		expect(shares[shares.length - 1]).toBeGreaterThan(dense);
		expect(shares[shares.length - 1]).toBeLessThan(sparse);
		wall += 1000 / 60;
		lightning.setTime(340_000, undefined, 600);
		expect(lightning.heroShare).toBeCloseTo(dense, 9);
		lightning.dispose();
	});

	it('keeps half a sprite outside the sample on the frames without a cloud light', () => {
		const ring = burst();
		const fakeRenderer = {
			getRenderTarget: () => null,
			getClearColor: (c: unknown) => c,
			getClearAlpha: () => 0,
			setRenderTarget: () => {},
			setClearColor: () => {},
			clear: () => {},
			render: () => {},
		} as unknown as WebGLRenderer;
		const camera = new PerspectiveCamera();
		camera.position.set(0, 0, 3);
		const off = (width: number, drawn: boolean[]) => {
			const lightning = createLightning(ring, { storage: null, lightMapWidth: width });
			const material = lightning.mesh.material as ShaderMaterial;
			lightning.stormView = true;
			const values = drawn.map((light) => {
				if (light) lightning.renderLightMap(fakeRenderer, camera);
				lightning.setTime(340_000, undefined, 600);
				return material.uniforms.lightMapOff.value as number;
			});
			lightning.dispose();
			return values;
		};
		expect(off(0, [false, true])).toEqual([1, 1]);
		expect(off(64, [false, true, true, false])).toEqual([1, 0, 0, 1]);
	});

	it('settles within 5 s of play on a storm of 2,000 flashes per wall second at 600×', () => {
		// 100 flashes over 1,000 s of scene time, then one every 300 ms for 4,000 s: 2,000 per wall second at 600×, each lit 0.4 s.
		const ring = new FlashRing(16_384);
		const flashes = [
			...Array.from({ length: 100 }, (_, i) => ({ offsetMs: i * 10_000, lat: (i % 50) * 0.1, lon: Math.floor(i / 50) * 0.1, source: 0 })),
			...Array.from({ length: 13_333 }, (_, i) => ({ offsetMs: 1_000_000 + i * 300, lat: (i % 100) * 0.05, lon: 5 + Math.floor(i / 100) * 0.05, source: 0 })),
		];
		ring.push(decodeChunk(encodeChunk(100, flashes).buffer));
		expect(flickerLength(ring.durationMs[ring.slot(0)]) + CHANNEL.fade).toBeCloseTo(DENSITY.aliveWindow, 9);
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		const material = lightning.mesh.material as ShaderMaterial;
		let wall = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => wall);
		lightning.stormView = true;
		let scene = 1_000_000;
		lightning.setTime(scene, undefined, 600);
		const sparse = lightning.heroShare;
		const wanted = 20 / (1.5 * 2000 * 0.4 * (600 / 600));
		expect(sparse).toBeGreaterThan(wanted * 10);
		let settled = Number.NaN;
		for (let frame = 1; frame <= 6 * 60; frame++) {
			wall += 1000 / 60;
			scene += 10_000;
			lightning.setTime(scene, undefined, 600);
			expect(material.uniforms.budgetFrom.value).toBe(-1e6);
			if (Number.isNaN(settled) && Math.abs(lightning.heroShare / wanted - 1) <= 0.1) settled = wall / 1000;
		}
		expect(settled).toBeLessThan(5);
		expect(Math.abs(lightning.heroShare / wanted - 1)).toBeLessThan(0.1);
		lightning.dispose();
	});
});

describe('light map window', () => {
	it('frames the view finely near the floor and the whole globe from afar', () => {
		const near = lightWindow({ lat: 0.3, lon: -0.8 }, 400);
		expect(near.x).toBe(-0.8);
		expect(near.y).toBe(0.3);
		expect(near.w).toBeCloseTo(1200 / 6371, 6);
		expect(near.z).toBeCloseTo((2 * near.w) / Math.cos(0.3 + near.w), 6);
		const far = lightWindow({ lat: 0.3, lon: -0.8 }, 20_000);
		expect([far.y, far.z, far.w]).toEqual([0, Math.PI, Math.PI / 2]);
	});

	it('stays within the poles as it grows', () => {
		const window = lightWindow({ lat: 1.4, lon: 0 }, 1000);
		expect(window.y + window.w).toBeCloseTo(Math.PI / 2, 6);
		expect(window.z).toBe(Math.PI);
	});
});
