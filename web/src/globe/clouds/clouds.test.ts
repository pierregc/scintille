import { Texture, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';
import { atmosphereParameters } from '../atmosphere';
import { CLOUD_TOP_KM } from '../lightning';
import { zoomLimits } from '../orbit';
import { isCloudToggleKey } from './dev';
import { CLOUD_MAX_GAP_MS, type Clouds, CLOUDS_RENDER_ORDER, cloudOpacityGlsl, cloudShellRadius, createClouds } from './index';
import { MAX_CLOUD_FRAMES } from './timeline';
import { CLOUDS_VISIBLE_KEY, type PreferenceStorage, readCloudsVisible, writeCloudsVisible } from './preference';

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { data: Record<string, string> } {
	const data = { ...initial };
	return {
		data,
		getItem: (key) => data[key] ?? null,
		setItem: (key, value) => {
			data[key] = value;
		},
	};
}

const throwing: PreferenceStorage = {
	getItem: () => {
		throw new Error('blocked');
	},
	setItem: () => {
		throw new Error('quota');
	},
};

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 15, 18);

function uniforms(clouds: Clouds) {
	return (clouds.mesh.material as unknown as { uniforms: Record<string, { value: unknown }> }).uniforms;
}

function frame(time = T0) {
	const texture = new Texture({ width: 2048, height: 1024 });
	let disposed = false;
	texture.addEventListener('dispose', () => (disposed = true));
	return { frame: { texture, time }, disposed: () => disposed };
}

describe('cloud shell', () => {
	it('sits between the ground and the lightning cloud tops, inside the atmosphere', () => {
		const lightningTop = 1 + CLOUD_TOP_KM / 6371;
		const shell = cloudShellRadius(1);
		expect(shell).toBeGreaterThan(1.001);
		expect(shell).toBeLessThan(lightningTop);
		expect(shell).toBeLessThan(atmosphereParameters(1).atmosphereRadius);
		expect(zoomLimits(1, 35, 1).min).toBeGreaterThan(shell);
	});

	it('draws before the atmosphere and the lightning', () => {
		expect(CLOUDS_RENDER_ORDER).toBeLessThan(0);
	});
});

describe('createClouds', () => {
	it('stays hidden until a frame arrives', () => {
		const clouds = createClouds(16, { storage: memoryStorage() });
		expect(clouds.mesh.visible).toBe(false);
		expect(clouds.frameTime).toBeNull();
		clouds.setFrame(frame().frame);
		expect(clouds.mesh.visible).toBe(true);
		expect(clouds.frameTime).toBe(T0);
	});

	it('glows from the flash light map only while one is set', () => {
		const clouds = createClouds(16, { storage: memoryStorage() });
		const { uniforms } = clouds.mesh.material as unknown as { uniforms: Record<string, { value: unknown }> };
		expect(uniforms.flashGain.value).toBe(0);
		const map = new Texture();
		const window = new Vector4(1, 0.5, 0.4, 0.2);
		clouds.setFlashLight({ map, window });
		expect(uniforms.flashLight.value).toBe(map);
		expect(uniforms.flashWindow.value).toBe(window);
		expect(uniforms.flashGain.value).toBeGreaterThan(0);
		clouds.setFlashLight(null);
		expect(uniforms.flashGain.value).toBe(0);
	});

	it('shares its opacity inputs with other materials', () => {
		const clouds = createClouds(16, { storage: null });
		const { uniforms: shared, defines } = clouds.opacity;
		expect(shared.cloudMap).toBe(uniforms(clouds).cloudMap);
		expect(shared.cloudShown.value).toBe(0);
		const f = frame();
		clouds.setFrame(f.frame);
		expect(shared.cloudMap.value).toBe(f.frame.texture);
		expect(shared.cloudShown.value).toBe(1);
		clouds.setVisible(false);
		expect(shared.cloudShown.value).toBe(0);
		expect(defines).toHaveProperty('BICUBIC');
		expect(cloudOpacityGlsl).toContain('float cloudOpacityAt(vec3 direction)');
	});

	it('toggles and remembers the choice', () => {
		const storage = memoryStorage();
		const clouds = createClouds(16, { storage });
		clouds.setFrame(frame().frame);
		clouds.setVisible(false);
		expect(clouds.mesh.visible).toBe(false);
		expect(storage.data[CLOUDS_VISIBLE_KEY]).toBe('0');
		expect(createClouds(16, { storage }).visible).toBe(false);
		clouds.setVisible(true);
		expect(clouds.mesh.visible).toBe(true);
	});

	it('keeps a bounded timeline and disposes what it drops', () => {
		const clouds = createClouds(16, { storage: null, anisotropy: 8 });
		const frames = Array.from({ length: MAX_CLOUD_FRAMES + 1 }, (_, i) => frame(T0 + i * HOUR));
		for (const f of frames) clouds.setFrame(f.frame);
		expect(frames[0].disposed()).toBe(true);
		expect(frames.slice(1).every((f) => !f.disposed())).toBe(true);
		expect(frames[1].frame.texture.anisotropy).toBe(8);
		const replacement = frame(frames[1].frame.time);
		clouds.setFrame(replacement.frame);
		expect(frames[1].disposed()).toBe(true);
		clouds.dispose();
		expect(replacement.disposed()).toBe(true);
		const late = frame();
		clouds.setFrame(late.frame);
		expect(late.disposed()).toBe(true);
	});

	it('keeps a valid blend when the frame it fades from is evicted', () => {
		const clouds = createClouds(16, { storage: null });
		const frames = Array.from({ length: MAX_CLOUD_FRAMES + 1 }, (_, i) => frame(T0 + i * HOUR));
		for (const f of frames.slice(0, -1)) clouds.setFrame(f.frame);
		clouds.setTime(T0 + 0.75 * HOUR);
		expect(uniforms(clouds).cloudMix.value).toBeCloseTo(0.75, 3);
		clouds.setFrame(frames[MAX_CLOUD_FRAMES].frame);
		const u = uniforms(clouds);
		expect(u.cloudMap.value).toBe(frames[1].frame.texture);
		expect(u.cloudMix.value).toBe(0);
		clouds.setTime(T0 + 0.75 * HOUR + 100);
		expect(u.cloudMix.value).toBeGreaterThanOrEqual(0);
		expect(u.cloudMix.value).toBeLessThanOrEqual(1);
	});

	it('crossfades between the frames around the scene time', () => {
		const clouds = createClouds(16, { storage: null });
		const first = frame();
		const second = frame(T0 + HOUR);
		clouds.setTime(T0 + HOUR / 4);
		clouds.setFrame(first.frame);
		clouds.setFrame(second.frame);
		let t = T0 + HOUR / 4;
		for (let i = 0; i < 60; i++, t += 1000) clouds.setTime(t);
		const u = uniforms(clouds);
		expect(u.cloudMap.value).toBe(first.frame.texture);
		expect(u.cloudMapNext.value).toBe(second.frame.texture);
		expect(u.cloudMix.value).toBeCloseTo((t - 1000 - T0) / HOUR, 3);
	});

	it('fades a new live frame in over scene time instead of popping', () => {
		const clouds = createClouds(16, { storage: null });
		let live = T0 + 2 * HOUR;
		clouds.setFrame(frame().frame);
		clouds.setTime(live);
		const next = frame(T0 + HOUR);
		clouds.setFrame(next.frame);
		expect(uniforms(clouds).cloudMix.value).toBe(0);
		clouds.setTime(live);
		expect(uniforms(clouds).cloudMix.value).toBe(0);
		clouds.setTime((live += 100));
		const mix = uniforms(clouds).cloudMix.value as number;
		expect(mix).toBeGreaterThan(0);
		expect(mix).toBeLessThan(0.2);
		for (let i = 0; i < 20; i++) clouds.setTime((live += 1000));
		expect(clouds.frameTime).toBe(next.frame.time);
	});

	it('gives the same picture for the same scene times, whatever the wall clock', () => {
		const run = () => {
			const clouds = createClouds(16, { storage: null });
			clouds.setFrame(frame().frame);
			clouds.setTime(T0 + 2 * HOUR);
			clouds.setFrame(frame(T0 + HOUR).frame);
			clouds.setTime(T0 + 2 * HOUR + 500);
			return uniforms(clouds).cloudMix.value;
		};
		expect(run()).toBe(run());
	});

	it('hides when the scene time is far from every frame', () => {
		const clouds = createClouds(16, { storage: null });
		clouds.setFrame(frame().frame);
		clouds.setTime(T0 + CLOUD_MAX_GAP_MS);
		expect(clouds.mesh.visible).toBe(true);
		expect(clouds.frameTime).toBe(T0);
		clouds.setTime(T0 + CLOUD_MAX_GAP_MS + 1);
		expect(clouds.mesh.visible).toBe(false);
		expect(clouds.frameTime).toBeNull();
		clouds.setFrame(frame(T0 + 2 * HOUR).frame);
		expect(clouds.mesh.visible).toBe(true);
	});

	it('keeps at most maxFrames', () => {
		const clouds = createClouds(16, { storage: null, maxFrames: 2 });
		const frames = [0, 1, 2].map((i) => frame(T0 + i * HOUR));
		for (const f of frames) clouds.setFrame(f.frame);
		expect(frames.map((f) => f.disposed())).toEqual([true, false, false]);
	});
});

describe('cloud visibility preference', () => {
	it('defaults to visible and reads a saved choice', () => {
		expect(readCloudsVisible(null)).toBe(true);
		expect(readCloudsVisible(memoryStorage())).toBe(true);
		expect(readCloudsVisible(memoryStorage({ [CLOUDS_VISIBLE_KEY]: '0' }))).toBe(false);
	});

	it('survives a storage that throws', () => {
		expect(readCloudsVisible(throwing)).toBe(true);
		expect(() => writeCloudsVisible(throwing, false)).not.toThrow();
	});
});

describe('isCloudToggleKey', () => {
	const key = (overrides: Partial<Parameters<typeof isCloudToggleKey>[0]> = {}) => ({
		key: 'c',
		repeat: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		target: null,
		...overrides,
	});

	it('accepts a bare c press', () => {
		expect(isCloudToggleKey(key())).toBe(true);
	});

	it('ignores shortcuts, repeats, other keys and text fields', () => {
		expect(isCloudToggleKey(key({ metaKey: true }))).toBe(false);
		expect(isCloudToggleKey(key({ repeat: true }))).toBe(false);
		expect(isCloudToggleKey(key({ key: 'C' }))).toBe(false);
		expect(isCloudToggleKey(key({ target: { tagName: 'INPUT' } as unknown as EventTarget }))).toBe(false);
		expect(isCloudToggleKey(key({ target: { isContentEditable: true } as unknown as EventTarget }))).toBe(false);
	});
});
