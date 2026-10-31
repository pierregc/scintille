import { AddEquation, AdditiveBlending, CustomBlending, InstancedBufferGeometry, MaxEquation, Mesh, OneFactor, OneMinusSrcColorFactor, PerspectiveCamera, ShaderMaterial, Vector2, type WebGLRenderer } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeChunk } from '../live/decode';
import { FlashRing } from '../live/ring';
import { encodeChunk } from '../live/testing';
import { NO_DELAY } from '../live/delay';
import { DENSITY, heroLot, heroShare } from './density';
import { CHANNEL, flashSeed } from './channel';
import { aliveCount, aliveLoad, budgetStart, createLightning, LIGHT_WINDOW, lightWindow, sampleCount } from './index';
import { FlashPlayback } from './playback';
import { flickerLength, PROFILE } from './profile';
import { MAX_SEGMENTS } from './skeleton';
import { maxBlendShare, PHONE, ZOOM } from './zoom';

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

/** The screen-blended copy of the glow, drawn while a storm view crosses from max to screen blending. */
function screenTwin(glow: Mesh): Mesh {
	const twin = glow.children.find((child) => child instanceof Mesh && child.geometry === glow.geometry);
	if (!(twin instanceof Mesh)) throw new Error('missing screen twin');
	return twin;
}

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

	it('keeps the brightest glow at each pixel near the floor and screen-blends from afar', () => {
		const lightning = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 0 });
		const material = lightning.mesh.material as ShaderMaterial;
		const twin = screenTwin(lightning.mesh);
		lightning.viewKmPerPx = 0.3;
		expect(material.blending).toBe(AdditiveBlending);
		expect(twin.visible).toBe(false);
		lightning.stormView = true;
		expect(material.blending).toBe(CustomBlending);
		expect(material.blendEquation).toBe(MaxEquation);
		expect([material.blendSrc, material.blendDst]).toEqual([OneFactor, OneFactor]);
		expect(twin.visible).toBe(false);
		lightning.viewKmPerPx = 2;
		expect(material.blendEquation).toBe(AddEquation);
		expect([material.blendSrc, material.blendDst]).toEqual([OneFactor, OneMinusSrcColorFactor]);
		expect(twin.visible).toBe(false);
		lightning.viewKmPerPx = ZOOM.floorKmPerPx * 0.9;
		expect(material.blendEquation).toBe(MaxEquation);
		lightning.stormView = false;
		expect(material.blending).toBe(AdditiveBlending);
		expect(twin.visible).toBe(false);
		lightning.dispose();
	});

	it('fades a screen-blended twin in under the max-blended glow on the way out, without a new material', () => {
		const lightning = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 0 });
		const material = lightning.mesh.material as ShaderMaterial;
		const twin = screenTwin(lightning.mesh);
		const twinMaterial = twin.material as ShaderMaterial;
		expect(twin.geometry).toBe(lightning.mesh.geometry);
		expect(twin.layers).toBe(lightning.mesh.layers);
		expect(twin.renderOrder).toBeLessThan(lightning.mesh.renderOrder);
		expect(twinMaterial.uniforms.time).toBe(material.uniforms.time);
		expect(twinMaterial.uniforms.nearGlowLevel).toBe(material.uniforms.nearGlowLevel);
		expect(material.uniforms.blendWeight.value).toBe(1);
		expect(twinMaterial.blendEquation).toBe(AddEquation);
		expect([twinMaterial.blendSrc, twinMaterial.blendDst]).toEqual([OneFactor, OneMinusSrcColorFactor]);
		lightning.stormView = true;
		let previous = 0;
		for (let kmPerPx = 0.6; kmPerPx < 1.1; kmPerPx *= 1.02) {
			lightning.viewKmPerPx = kmPerPx;
			const share = maxBlendShare(kmPerPx);
			expect(twin.visible).toBe(share > 0 && share < 1);
			expect(material.blendEquation).toBe(share > 0 ? MaxEquation : AddEquation);
			expect(material.uniforms.blendWeight.value).toBe(1);
			if (twin.visible) {
				expect(twinMaterial.uniforms.blendWeight.value).toBeCloseTo(1 - share, 9);
				expect(twinMaterial.uniforms.blendWeight.value).toBeGreaterThanOrEqual(previous);
				previous = twinMaterial.uniforms.blendWeight.value as number;
			}
		}
		expect(previous).toBeGreaterThan(0.9);
		lightning.dispose();
	});

	it('picks the blend from the zoom a phone draws at', () => {
		const lightning = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 0, phone: true });
		const material = lightning.mesh.material as ShaderMaterial;
		const renderer = { getSize: (target: Vector2) => target.set(375, PHONE.viewHeight * 0.75) } as unknown as WebGLRenderer;
		// Only the renderer size matters to the glow before it draws.
		(lightning.mesh.onBeforeRender as unknown as (renderer: WebGLRenderer) => void)(renderer);
		lightning.stormView = true;
		lightning.viewKmPerPx = 1.2;
		expect(material.blendEquation).toBe(MaxEquation);
		expect(screenTwin(lightning.mesh).visible).toBe(true);
		lightning.viewKmPerPx = 1.4;
		expect(material.blendEquation).toBe(AddEquation);
		lightning.dispose();
	});

	it('draws the glow at a fraction near the floor only while the lit cloud carries the flash', () => {
		const level = (lightning: ReturnType<typeof createLightning>) => (lightning.mesh.material as ShaderMaterial).uniforms.nearGlowLevel.value as number;
		const lit = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 64 });
		expect(lit.cloudLit).toBe(true);
		expect(level(lit)).toBe(ZOOM.nearGlowLevel);
		lit.cloudLit = false;
		expect(level(lit)).toBe(ZOOM.glowLevel);
		lit.cloudLit = true;
		expect(level(lit)).toBe(ZOOM.nearGlowLevel);
		lit.dispose();
		const unlit = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 0 });
		expect(unlit.cloudLit).toBe(false);
		unlit.cloudLit = true;
		expect(unlit.cloudLit).toBe(false);
		expect(level(unlit)).toBe(ZOOM.glowLevel);
		unlit.dispose();
		const phone = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 64, phone: true });
		const uniforms = (phone.mesh.material as ShaderMaterial).uniforms;
		expect(level(phone)).toBeCloseTo(ZOOM.nearGlowLevel * PHONE.nearLevel, 9);
		expect(uniforms.glowLevel.value).toBeCloseTo(ZOOM.glowLevel * PHONE.nearLevel, 9);
		phone.cloudLit = false;
		expect(level(phone)).toBeCloseTo(ZOOM.glowLevel * PHONE.nearLevel, 9);
		phone.dispose();
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

	it('draws a share of the flashes sized for the replay speed and keeps the newest-flashes cap for the points outside it', () => {
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
		expect(material.uniforms.pointBudgetFrom.value).toBeCloseTo((budgetStart(ring, 340_000, 500) - 340_000) / 1000, 6);
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
		expect(material.uniforms.pointBudgetFrom.value).toBe(-1e6);
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

	it('eases the flashes outside the sample to half a sprite while no cloud light is drawn', () => {
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
		let wall = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => wall);
		const off = (width: number, drawn: boolean[]) => {
			const lightning = createLightning(ring, { storage: null, lightMapWidth: width });
			const material = lightning.mesh.material as ShaderMaterial;
			lightning.stormView = true;
			const values = drawn.map((light) => {
				wall += 1000 / 60;
				if (light) lightning.renderLightMap(fakeRenderer, camera);
				lightning.setTime(340_000, undefined, 600);
				return material.uniforms.lightMapOff.value as number;
			});
			lightning.dispose();
			return values;
		};
		expect(off(0, [false, true])).toEqual([1, 1]);
		// 15 frames of 1/60 s make the 0.25 s fade.
		const values = off(64, [false, ...Array<boolean>(16).fill(true), false, false]);
		const expected = [1, ...Array.from({ length: 16 }, (_, k) => Math.max(0, 1 - (k + 1) / 15)), 1 / 15, 2 / 15];
		values.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 9));
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

	it('keeps the drawn count on target through a speed change during play', () => {
		// One flash every 300 ms of scene time, each lit 0.4 s: 80 alive at once at 60×, 800 at 600×.
		const ring = new FlashRing(8192);
		ring.push(decodeChunk(encodeChunk(100, Array.from({ length: 8000 }, (_, i) => ({ offsetMs: i * 300, lat: (i % 100) * 0.05, lon: Math.floor(i / 100) * 0.05, source: 0 }))).buffer));
		expect(flickerLength(ring.durationMs[ring.slot(0)]) + CHANNEL.fade).toBeCloseTo(DENSITY.aliveWindow, 9);
		let wall = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => wall);
		/** Expected drawn count over the target, `1.5 × share × alive / target`, on each frame of the 2 s after switching from `before` to `after`. */
		const through = (before: number, after: number) => {
			const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
			lightning.stormView = true;
			let scene = 160_000;
			const frame = (speed: number) => {
				wall += 1000 / 60;
				scene += (speed * 1000) / 60;
				lightning.setTime(scene, undefined, speed);
				const { share, alive, target } = lightning.stats;
				return (DENSITY.meanWeight * share * alive) / target;
			};
			for (let f = 0; f < 3 * 60; f++) frame(before);
			const ratios = Array.from({ length: 2 * 60 }, () => frame(after));
			lightning.dispose();
			return ratios;
		};
		for (const ratios of [through(60, 600), through(600, 60)]) {
			expect(Math.max(...ratios)).toBeLessThanOrEqual(1.1);
			expect(Math.min(...ratios)).toBeGreaterThanOrEqual(0.9);
		}
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

	it('ends each lit disc at the footprint near the floor, below the channels', () => {
		expect(LIGHT_WINDOW.nearSplat).toBe(1.3);
		expect(LIGHT_WINDOW.nearLevel).toBe(0.35);
		expect(LIGHT_WINDOW.heightScale).toBe(3);
		expect([LIGHT_WINDOW.farSplat, LIGHT_WINDOW.farSpreadKm]).toEqual([3, 150]);
	});
});
