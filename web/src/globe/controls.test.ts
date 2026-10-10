import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGlobeControls, type GlobeControls } from './controls';
import { worldToKm } from './flight';

const R = 1;

function fakeElement() {
	const listeners = new Map<string, (event: unknown) => void>();
	const doc = { addEventListener() {}, removeEventListener() {} };
	const element = {
		addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
		removeEventListener() {},
		setPointerCapture() {},
		releasePointerCapture() {},
		style: {},
		getRootNode: () => doc,
		ownerDocument: doc,
	};
	const pointerDown = () =>
		listeners.get('pointerdown')?.({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0 });
	return { element: element as unknown as HTMLElement, pointerDown };
}

describe('createGlobeControls flight handoff', () => {
	let time = 0;
	let camera: PerspectiveCamera;
	let controls: GlobeControls;
	let pointerDown: () => void;

	beforeEach(() => {
		vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
		time = 0;
		camera = new PerspectiveCamera(45, 1, 0.1, 100);
		const fake = fakeElement();
		pointerDown = fake.pointerDown;
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
});
