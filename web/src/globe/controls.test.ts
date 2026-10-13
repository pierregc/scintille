import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGlobeControls, type GlobeControls } from './controls';
import { worldToKm } from './flight';

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

	const settle = async (flight: Promise<boolean>) => {
		step(1);
		await flight;
	};
});
