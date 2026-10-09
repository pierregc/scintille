import { Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { atmosphereParameters } from '../atmosphere';
import { CLOUD_TOP_KM } from '../lightning';
import { zoomLimits } from '../orbit';
import { isCloudToggleKey } from './dev';
import { CLOUD_FIXTURE, cloudFixtureUrl } from './frame';
import { type Clouds, CLOUDS_RENDER_ORDER, cloudShellRadius, createClouds } from './index';
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

function uniforms(clouds: Clouds) {
	return (clouds.mesh.material as unknown as { uniforms: Record<string, { value: unknown }> }).uniforms;
}

function frame(time = CLOUD_FIXTURE.time) {
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
		expect(zoomLimits(1, 35, 1, 0.1, 100).min).toBeGreaterThan(shell);
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
		expect(clouds.frameTime).toBe(CLOUD_FIXTURE.time);
	});

	it('glows from the flash light map only while one is set', () => {
		const clouds = createClouds(16, { storage: memoryStorage() });
		const { uniforms } = clouds.mesh.material as unknown as { uniforms: Record<string, { value: unknown }> };
		expect(uniforms.flashGain.value).toBe(0);
		const map = new Texture();
		clouds.setFlashLight(map);
		expect(uniforms.flashLight.value).toBe(map);
		expect(uniforms.flashGain.value).toBeGreaterThan(0);
		clouds.setFlashLight(null);
		expect(uniforms.flashGain.value).toBe(0);
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
		const frames = Array.from({ length: MAX_CLOUD_FRAMES + 1 }, (_, i) => frame(CLOUD_FIXTURE.time + i * HOUR));
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

	it('crossfades between the frames around the scene time', () => {
		let wall = 0;
		const clouds = createClouds(16, { storage: null, now: () => wall });
		const first = frame();
		const second = frame(CLOUD_FIXTURE.time + HOUR);
		clouds.setFrame(first.frame);
		clouds.setFrame(second.frame);
		for (let i = 0; i < 20; i++, wall += 1000) clouds.setTime(CLOUD_FIXTURE.time + HOUR / 4);
		const u = uniforms(clouds);
		expect(u.cloudMap.value).toBe(first.frame.texture);
		expect(u.cloudMapNext.value).toBe(second.frame.texture);
		expect(u.cloudMix.value).toBeCloseTo(0.25, 3);
	});

	it('fades a new live frame in instead of popping', () => {
		let wall = 0;
		const clouds = createClouds(16, { storage: null, now: () => wall });
		const live = CLOUD_FIXTURE.time + 3 * HOUR;
		clouds.setFrame(frame().frame);
		clouds.setTime(live);
		const next = frame(CLOUD_FIXTURE.time + HOUR);
		clouds.setFrame(next.frame);
		expect(uniforms(clouds).cloudMix.value).toBe(0);
		wall += 100;
		clouds.setTime(live);
		const mix = uniforms(clouds).cloudMix.value as number;
		expect(mix).toBeGreaterThan(0);
		expect(mix).toBeLessThan(0.2);
		for (let i = 0; i < 20; i++, wall += 1000) clouds.setTime(live);
		expect(clouds.frameTime).toBe(next.frame.time);
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

describe('cloudFixtureUrl', () => {
	it('resolves the fixture against the feed root', () => {
		expect(cloudFixtureUrl('http://localhost:8787/')).toBe(
			'http://localhost:8787/clouds/gmgsi_20260715T180000Z.webp',
		);
		expect(CLOUD_FIXTURE.time).toBe(Date.parse('2026-07-15T18:00:00Z'));
	});
});
