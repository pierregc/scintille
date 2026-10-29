import { describe, expect, it } from 'vitest';
import type { FlyToOptions } from '../flight';
import { ahead, GRAZE } from '../replay/framing';
import { floorRange } from '../surface';
import { dampStep, FOLLOW, followView, StormFollow } from './follow';

const RAD = Math.PI / 180;

function fakeControls(start: Required<Omit<FlyToOptions, 'duration'>>) {
	let current = { ...start };
	const input = new Set<() => void>();
	const state = {
		placed: [] as FlyToOptions[],
		flights: [] as { view: FlyToOptions; resolve: (arrived: boolean) => void }[],
		flying: false,
		surface: true,
	};
	const controls = {
		flyTo(view: FlyToOptions) {
			state.flying = true;
			return new Promise<boolean>((resolve) => state.flights.push({ view, resolve: (arrived) => {
				state.flying = false;
				if (arrived) current = { ...current, ...view, altitude: view.altitude ?? current.altitude, tilt: view.tilt ?? 0, heading: view.heading ?? 0 };
				resolve(arrived);
			} }));
		},
		place(view: FlyToOptions) {
			state.placed.push(view);
			current = { lat: view.lat, lon: view.lon, altitude: view.altitude ?? current.altitude, tilt: view.tilt ?? 0, heading: view.heading ?? 0 };
		},
		view: () => current,
		flying: () => state.flying,
		onSurface: () => state.surface,
		onInput(listener: () => void) {
			input.add(listener);
			return () => input.delete(listener);
		},
	};
	return { controls, state, input: () => { for (const l of input) l(); } };
}

const view = () => ({ fov: 35, aspect: 16 / 9 });

describe('follow framing', () => {
	it('frames small footprints at the floor and backs off for large ones', () => {
		const small = followView({ lat: -14, lon: -44, radiusKm: 20 }, 'frame', 0, 35, 16 / 9);
		const large = followView({ lat: -14, lon: -44, radiusKm: 125 }, 'frame', 0, 35, 16 / 9);
		const floor = floorRange(20 * RAD, 1) * 6371;
		expect(small.altitude).toBeGreaterThanOrEqual(floor);
		expect(small.altitude).toBeLessThan(floor * 1.03);
		expect(large.altitude).toBeGreaterThan(small.altitude * 1.2);
		expect(large).toMatchObject({ lat: -14, lon: -44, tilt: 20, leadKm: 0 });
	});

	it('keeps the horizon view at the floor, aimed ahead along the heading', () => {
		const pose = followView({ lat: 40, lon: 2, radiusKm: 50 }, 'horizon', 90, 35, 16 / 9);
		const aim = ahead({ lat: 40, lon: 2 }, 90, GRAZE.leadKm);
		expect(pose).toMatchObject({ tilt: GRAZE.tilt, heading: 90, leadKm: GRAZE.leadKm });
		expect(pose.lat).toBeCloseTo(aim.lat, 6);
		expect(pose.lon).toBeCloseTo(aim.lon, 6);
		expect(pose.altitude).toBeCloseTo(floorRange(GRAZE.tilt * RAD, 1) * 6371 + 1, 3);
	});
});

describe('critically damped glide', () => {
	it('reaches the target without overshoot from rest', () => {
		let [x, v] = [1, 0];
		let previous = x;
		for (let i = 0; i < 300; i++) {
			[x, v] = dampStep(x, v, FOLLOW.omega, 1 / 60);
			expect(x).toBeLessThanOrEqual(previous);
			expect(x).toBeGreaterThanOrEqual(0);
			previous = x;
		}
		expect(x).toBeLessThan(1e-3);
		expect(dampStep(1, 0, FOLLOW.omega, 2)[0]).toBeLessThan(0.05);
	});
});

describe('following a storm', () => {
	const start = { lat: 0, lon: 0, altitude: 600, tilt: 20, heading: 0 };

	it('glides to each new position, never past it, then settles', () => {
		const { controls, state } = fakeControls(start);
		const follow = new StormFollow(controls, view);
		follow.start({ lat: 0, lon: 0, radiusKm: 40 }, 'frame', 0);
		expect(state.flights).toHaveLength(0);
		let now = 0;
		const run = (ms: number, target: { lat: number; lon: number; radiusKm: number } | null) => {
			for (let t = 0; t < ms; t += 16) follow.update((now += 16), target);
		};
		run(6000, { lat: 0, lon: 0, radiusKm: 40 });
		const settled = state.placed.length;
		run(500, { lat: 0, lon: 0, radiusKm: 40 });
		expect(state.placed.length).toBe(settled);
		state.placed.length = 0;
		run(9000, { lat: 0.5, lon: 0, radiusKm: 40 });
		const lats = state.placed.map((p) => p.lat);
		expect(lats.at(-1)).toBeCloseTo(0.5, 9);
		for (let i = 1; i < lats.length; i++) expect(lats[i]).toBeGreaterThanOrEqual(lats[i - 1] - 1e-12);
		expect(Math.max(...lats)).toBeLessThanOrEqual(0.5 + 1e-12);
		const steps = lats.slice(1).map((lat, i) => lat - lats[i]);
		expect(Math.max(...steps)).toBeLessThan(0.5 / 30);
	});

	it('holds the last position while none is current', () => {
		const { controls, state } = fakeControls(start);
		const follow = new StormFollow(controls, view);
		follow.start({ lat: 0, lon: 0, radiusKm: 40 }, 'frame', 0);
		let now = 0;
		for (let t = 0; t < 7000; t += 16) follow.update((now += 16), t < 1000 ? { lat: 0.2, lon: 0, radiusKm: 40 } : null);
		expect(state.placed.at(-1)?.lat).toBeCloseTo(0.2, 9);
		expect(follow.active).toBe(true);
	});

	it('flies to a storm far from the camera and tracks it on arrival', async () => {
		const { controls, state } = fakeControls(start);
		const follow = new StormFollow(controls, view);
		follow.start({ lat: 20, lon: 30, radiusKm: 40 }, 'frame', 0);
		expect(state.flights).toHaveLength(1);
		follow.update(16, { lat: 20, lon: 30, radiusKm: 40 });
		expect(state.placed).toHaveLength(0);
		state.flights[0].resolve(true);
		await Promise.resolve();
		follow.update(32, { lat: 20, lon: 30, radiusKm: 40 });
		expect(follow.active).toBe(true);
		expect(state.placed.at(-1)?.lat).toBeCloseTo(20, 9);
	});

	it('stops on visitor input, an interrupted flight or another flight', async () => {
		const first = fakeControls(start);
		const follow = new StormFollow(first.controls, view);
		follow.start({ lat: 0, lon: 0, radiusKm: 40 }, 'frame', 0);
		first.input();
		expect(follow.active).toBe(false);

		follow.start({ lat: 10, lon: 10, radiusKm: 40 }, 'frame', 0);
		first.state.flights[0].resolve(false);
		await Promise.resolve();
		expect(follow.active).toBe(false);

		const second = fakeControls(start);
		const other = new StormFollow(second.controls, view);
		other.start({ lat: 0, lon: 0, radiusKm: 40 }, 'frame', 0);
		second.state.flying = true;
		other.update(16, { lat: 0, lon: 0, radiusKm: 40 });
		expect(other.active).toBe(false);
	});

	it('moves at once when the visitor prefers reduced motion', () => {
		const { controls, state } = fakeControls(start);
		const follow = new StormFollow(controls, view, () => true);
		follow.start({ lat: 0, lon: 0, radiusKm: 40 }, 'frame', 0);
		follow.update(16, { lat: 0.3, lon: 0, radiusKm: 40 });
		expect(state.placed.at(-1)?.lat).toBeCloseTo(0.3, 9);
	});

	it('switches between the storm frame and the horizon view without a flight', () => {
		const { controls, state } = fakeControls(start);
		const follow = new StormFollow(controls, view);
		follow.start({ lat: 0, lon: 0, radiusKm: 40 }, 'frame', 0);
		follow.setMode('horizon', 90);
		let now = 0;
		for (let t = 0; t < 8000; t += 16) follow.update((now += 16), { lat: 0, lon: 0, radiusKm: 40 });
		expect(state.flights).toHaveLength(0);
		const last = state.placed.at(-1);
		expect(last?.tilt).toBeCloseTo(GRAZE.tilt, 6);
		expect(last?.heading).toBeCloseTo(90, 6);
		expect(last?.lon).toBeCloseTo(ahead({ lat: 0, lon: 0 }, 90, GRAZE.leadKm).lon, 6);
	});
});
