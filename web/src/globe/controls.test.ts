import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGlobeControls, type GlobeControls } from './controls';
import { worldToKm } from './flight';
import fixture from '../../../fixtures/storms/2026-07-15-orlando.json';
import type { StormDetail } from '../contract/types';
import { SceneClock } from './clock';
import { StormReplay } from './replay';
import { ReplayNavigation } from './replay/navigation';
import { REPLAY_FRAME } from './replay/framing';

const R = 1;

function fakeElement() {
	const listeners = new Map<string, ((event: unknown) => void)[]>();
	const doc = { addEventListener() {}, removeEventListener() {} };
	const element = {
		addEventListener: (type: string, listener: (event: unknown) => void) =>
			listeners.set(type, [...(listeners.get(type) ?? []), listener]),
		removeEventListener() {},
		clientHeight: 800,
		setPointerCapture() {},
		releasePointerCapture() {},
		style: {},
		getRootNode: () => doc,
		ownerDocument: doc,
	};
	const fire = (type: string, event: Record<string, unknown>) => {
		for (const listener of listeners.get(type) ?? []) {
			listener({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0, preventDefault() {}, ...event });
		}
	};
	const pointerDown = () => fire('pointerdown', {});
	return { element: element as unknown as HTMLElement, pointerDown, fire };
}

describe('createGlobeControls flight handoff', () => {
	let time = 0;
	let camera: PerspectiveCamera;
	let controls: GlobeControls;
	let pointerDown: () => void;
	let fire: (type: string, event: Record<string, unknown>) => void;

	beforeEach(() => {
		vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
		time = 0;
		camera = new PerspectiveCamera(45, 1, 0.1, 100);
		const fake = fakeElement();
		pointerDown = fake.pointerDown;
		fire = fake.fire;
		controls = createGlobeControls(camera, fake.element, R, { now: () => time });
		controls.resize();
	});

	afterEach(() => {
		controls.dispose();
		vi.unstubAllGlobals();
	});

	const step = (ms: number) => {
		time += ms;
		controls.update(time);
	};

	it('clamps a too-low nadir destination so arrival does not jump', async () => {
		const arrived = controls.flyTo({ lat: 10, lon: 20, altitude: 400, duration: 1000 });
		step(999);
		const beforeArrival = camera.position.clone();
		step(1);
		await expect(arrived).resolves.toBe(true);
		expect(camera.position.distanceTo(beforeArrival)).toBeLessThan(0.01);
		const atArrival = camera.position.clone();
		step(16);
		expect(camera.position.distanceTo(atArrival)).toBeLessThan(1e-6);
		expect(worldToKm(camera.position.length() - R, R)).toBeGreaterThan(400);
	});

	it('keeps the camera orientation when the user interrupts a polar flight', async () => {
		const first = controls.flyTo({ lat: 60, lon: 0, duration: 0 });
		step(1);
		await first;
		const flight = controls.flyTo({ lat: 60, lon: 180, duration: 1000 });
		step(500);
		const before = camera.quaternion.clone();
		pointerDown();
		await expect(flight).resolves.toBe(false);
		expect(camera.quaternion.angleTo(before)).toBeLessThan(1e-6);
		step(16);
		expect(camera.quaternion.angleTo(before)).toBeLessThan(0.05);
		for (let i = 0; i < 60; i++) step(16);
		const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
		const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
		expect(up.dot(new Vector3(0, 1, 0).projectOnPlane(forward).normalize())).toBeCloseTo(1, 3);
	});

	const height = () => camera.position.length() - R;
	const tiltOf = () => {
		const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
		const b = camera.position.dot(forward);
		const ground = camera.position.clone().addScaledVector(forward, -b - Math.sqrt(b * b - camera.position.lengthSq() + R * R));
		return (forward.clone().negate().angleTo(ground.normalize()) * 180) / Math.PI;
	};
	const drag = (dy: number, event: Record<string, unknown>) => {
		fire('pointerdown', { clientY: 0, ...event });
		for (let y = 0; Math.abs(y) < Math.abs(dy); y += Math.sign(dy) * 10) fire('pointermove', { clientY: y, ...event });
		fire('pointerup', { clientY: dy, ...event });
	};

	it('tilts toward the horizon with a right drag and keeps the camera above the clouds', async () => {
		await settle(controls.flyTo({ lat: 10, lon: 20, altitude: 300, tilt: 0, duration: 0 }));
		drag(-2000, { button: 2 });
		expect(tiltOf()).toBeGreaterThan(30);
		expect(worldToKm(height(), R)).toBeGreaterThan(15);
		drag(2000, { button: 2 });
		expect(tiltOf()).toBeLessThan(1);
	});

	it('places a surface view at once and reports visitor input', async () => {
		const inputs: string[] = [];
		const off = controls.onInput(() => inputs.push('input'));
		controls.place({ lat: 10, lon: 20, altitude: 700, tilt: 20, heading: 30 });
		expect(controls.onSurface()).toBe(true);
		expect(controls.flying()).toBe(false);
		const view = controls.view();
		expect(view.lat).toBeCloseTo(10, 6);
		expect(view.lon).toBeCloseTo(20, 6);
		expect(view.altitude).toBeCloseTo(700, 3);
		expect(view.tilt).toBeCloseTo(20, 6);
		expect(view.heading).toBeCloseTo(30, 6);
		controls.place({ lat: 10, lon: 20, altitude: 10, tilt: 20 });
		expect(controls.view().altitude).toBeGreaterThan(400);
		const flight = controls.flyTo({ lat: 0, lon: 0, altitude: 900, tilt: 20, duration: 1000 });
		controls.place({ lat: 40, lon: 40, altitude: 700, tilt: 20 });
		expect(controls.flying()).toBe(true);
		expect(controls.view().lat).toBeLessThan(15);
		fire('wheel', { deltaY: 10, deltaMode: 0 });
		await expect(flight).resolves.toBe(false);
		pointerDown();
		expect(inputs).toEqual(['input', 'input']);
		off();
		pointerDown();
		expect(inputs).toHaveLength(2);
	});

	it('holds the idle rotation while asked, then waits a full idle delay', () => {
		const start = camera.position.clone();
		step(16);
		step(16);
		expect(camera.position.distanceTo(start)).toBeGreaterThan(1e-6);
		controls.holdRotation(true);
		for (let i = 0; i < 300; i++) step(16);
		const held = camera.position.clone();
		for (let i = 0; i < 100; i++) step(500);
		expect(camera.position.distanceTo(held)).toBeLessThan(1e-9);
		controls.holdRotation(false);
		for (let i = 0; i < 39; i++) step(500);
		expect(camera.position.distanceTo(held)).toBeLessThan(1e-9);
		step(600);
		step(16);
		expect(camera.position.distanceTo(held)).toBeGreaterThan(1e-6);
	});

	it('tilts with a ctrl click, as on a Mac trackpad', () => {
		const before = camera.position.clone();
		drag(-100, { button: 0, ctrlKey: true });
		expect(camera.position.distanceTo(before)).toBeGreaterThan(0.01);
	});

	it('tilts with a two finger vertical drag', () => {
		const before = camera.position.clone();
		const touch = { pointerType: 'touch' };
		fire('pointerdown', { ...touch, pointerId: 1, clientX: 0, clientY: 0 });
		fire('pointerdown', { ...touch, pointerId: 2, clientX: 100, clientY: 0 });
		for (let y = 0; y > -200; y -= 10) {
			fire('pointermove', { ...touch, pointerId: 1, clientX: 0, clientY: y });
			fire('pointermove', { ...touch, pointerId: 2, clientX: 100, clientY: y });
		}
		fire('pointerup', { ...touch, pointerId: 1 });
		fire('pointerup', { ...touch, pointerId: 2 });
		expect(camera.position.distanceTo(before)).toBeGreaterThan(0.01);
	});

	it('eases back to the globe view when zooming out of a tilted view', async () => {
		await settle(controls.flyTo({ lat: 10, lon: 20, altitude: 500, tilt: 60, duration: 0 }));
		for (let i = 0; i < 20; i++) fire('wheel', { deltaY: 200, deltaMode: 0 });
		for (let i = 0; i < 80; i++) step(16);
		expect(tiltOf()).toBeLessThan(0.5);
		const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
		expect(forward.dot(camera.position.clone().normalize())).toBeCloseTo(-1, 3);
	});

	it.each([16 / 9, 9 / 16])('round trips a dragged zero-tilt surface view through sharing and history at aspect %s', async (aspect) => {
		camera.fov = 35;
		camera.aspect = aspect;
		camera.updateProjectionMatrix();
		controls.resize();
		const clock = new SceneClock(() => time);
		const data = {
			openStorm: vi.fn(async () => { clock.replay(Date.parse(fixture.storm.t_start), 60); return fixture as StormDetail; }),
			live: async () => { clock.live(); },
		};
		const replay = new StormReplay(data, clock, controls, 'https://feed.test/', () => ({ fov: camera.fov, aspect }));
		let url = new URL('https://scintille.app/');
		const navigation = new ReplayNavigation(replay, clock, controls, {
			url: () => url, write: (next) => { url = next; }, onPop: () => () => {},
		});
		try {
			const opening = replay.open(fixture.storm.slug);
			await Promise.resolve();
			step(2800);
			await opening;
			drag(2000, { button: 2 });
			const original = controls.view();
			expect(original.tilt).toBeCloseTo(0, 4);
			expect(original.altitude).toBeCloseTo(432.5, 1);
			const shared = navigation.shareUrl();
			for (const fresh of [false, true]) {
				if (fresh) await replay.live();
				await settle(controls.flyTo({ lat: 0, lon: 0, altitude: 5000, duration: 0 }));
				url = new URL(shared);
				const restoring = navigation.restore();
				await Promise.resolve();
				step(1);
				await restoring;
				for (let i = 0; i < 60; i++) step(16);
				const restored = controls.view();
				expect(restored.lat).toBeCloseTo(original.lat, 4);
				expect(restored.lon).toBeCloseTo(original.lon, 4);
				expect(restored.altitude).toBeCloseTo(original.altitude, 3);
				expect(restored.tilt).toBeCloseTo(0, 4);
				expect(clock.playing).toBe(false);
				expect(data.openStorm).toHaveBeenCalledTimes(fresh ? 2 : 1);
			}
		} finally { navigation.dispose(); replay.dispose(); }
	});

	it.each([16 / 9, 9 / 16].flatMap((aspect) => [false, true].map((completed) => ({ aspect, completed }))))(
		'reframes on reload after moving the camera at aspect $aspect (approach completed: $completed)', async ({ aspect, completed }) => {
			camera.fov = 35;
			camera.aspect = aspect;
			camera.updateProjectionMatrix();
			controls.resize();
			let url = new URL(`https://scintille.app/?storm=${fixture.storm.slug}&speed=60`);
			const session = () => {
				const clock = new SceneClock(() => time);
				const data = {
					openStorm: async () => { clock.replay(Date.parse(fixture.storm.t_start), 60); return fixture as StormDetail; },
					live: async () => { clock.live(); },
				};
				const replay = new StormReplay(data, clock, controls, 'https://feed.test/', () => ({ fov: camera.fov, aspect }));
				const navigation = new ReplayNavigation(replay, clock, controls, {
					url: () => url, write: (next) => { url = next; }, onPop: () => () => {},
				});
				return { navigation, replay, dispose: () => { navigation.dispose(); replay.dispose(); } };
			};
			const first = session();
			try {
				const opening = first.navigation.restore();
				await Promise.resolve();
				if (completed) {
					step(2800);
					await opening;
					drag(-120, { button: 2 });
				} else {
					step(1000);
					pointerDown();
					await opening;
				}
				expect(url.searchParams.has('view')).toBe(false);
			} finally { first.dispose(); }
			controls.dispose();
			const fake = fakeElement();
			controls = createGlobeControls(camera, fake.element, R, { now: () => time });
			controls.resize();
			const fresh = session();
			try {
				let arrived = false;
				const restoring = fresh.navigation.restore().then(() => { arrived = true; });
				await Promise.resolve();
				const start = camera.position.clone();
				step(1400);
				await Promise.resolve();
				expect(arrived).toBe(false);
				expect(camera.position.distanceTo(start)).toBeGreaterThan(0.01);
				step(1400);
				await restoring;
				expect(controls.view().altitude).toBeCloseTo(432.5, 1);
				expect(controls.view().tilt).toBeCloseTo(REPLAY_FRAME.tilt, 4);
				expect(url.searchParams.has('view')).toBe(false);
			} finally { fresh.dispose(); }
	});

	it('finishes immediately when already at the requested pose, but reframes a changed heading', async () => {
		const target = { lat: 28.5, lon: -81.3, altitude: 500, tilt: 12, duration: 2800 };
		await settle(controls.flyTo({ ...target, duration: 0 }));
		const position = camera.position.clone();
		const rotation = camera.quaternion.clone();
		expect(controls.isAt(target)).toBe(true);
		const unchanged = controls.flyTo(target);
		step(0);
		await expect(unchanged).resolves.toBe(true);
		expect(camera.position.distanceTo(position)).toBeLessThan(1e-6);
		expect(camera.quaternion.angleTo(rotation)).toBeLessThan(1e-6);
		fire('pointerdown', { button: 2 });
		fire('pointermove', { button: 2, clientX: 100 });
		fire('pointerup', { button: 2, clientX: 100 });
		expect(controls.view()).toMatchObject({ lat: expect.closeTo(target.lat, 4), lon: expect.closeTo(target.lon, 4),
			altitude: expect.closeTo(target.altitude, 4), tilt: expect.closeTo(target.tilt, 4) });
		expect(camera.quaternion.angleTo(rotation)).toBeGreaterThan(0.1);
		expect(controls.isAt(target)).toBe(false);
		let arrived = false;
		const reframing = controls.flyTo(target).then(() => { arrived = true; });
		step(0);
		await Promise.resolve();
		expect(arrived).toBe(false);
		step(2800);
		await reframing;
		expect(camera.quaternion.angleTo(rotation)).toBeLessThan(1e-6);
	});

	const settle = async (flight: Promise<boolean>) => {
		step(1);
		await flight;
	};
});
