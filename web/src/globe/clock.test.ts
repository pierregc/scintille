import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneClock } from './clock';

const T0 = Date.UTC(2026, 9, 5, 18, 0);
const STORM = Date.UTC(2026, 6, 15, 18, 30);

let wall: number;
let clock: SceneClock;

beforeEach(() => {
	wall = T0;
	clock = new SceneClock(() => wall);
});

describe('live', () => {
	it('follows the wall clock', () => {
		expect(clock.mode).toBe('live');
		expect(clock.time()).toBe(T0);
		wall += 5000;
		expect(clock.time()).toBe(T0 + 5000);
	});

	it('refuses seeking', () => {
		expect(() => clock.seek(STORM)).toThrow();
	});
});

describe('replay', () => {
	it('starts at the given time and runs at the given speed', () => {
		clock.replay(STORM, 60);
		expect(clock.time()).toBe(STORM);
		wall += 1000;
		expect(clock.time()).toBe(STORM + 60_000);
	});

	it('freezes on pause and resumes where it stopped', () => {
		clock.replay(STORM);
		wall += 1000;
		clock.pause();
		wall += 10_000;
		expect(clock.time()).toBe(STORM + 1000);
		clock.play();
		wall += 1000;
		expect(clock.time()).toBe(STORM + 2000);
	});

	it('keeps time continuous across speed changes', () => {
		clock.replay(STORM, 2);
		wall += 1000;
		clock.setSpeed(10);
		expect(clock.time()).toBe(STORM + 2000);
		wall += 1000;
		expect(clock.time()).toBe(STORM + 12_000);
	});

	it('changes speed while paused without moving', () => {
		clock.replay(STORM);
		clock.pause();
		clock.setSpeed(30);
		wall += 1000;
		expect(clock.time()).toBe(STORM);
		clock.play();
		wall += 1000;
		expect(clock.time()).toBe(STORM + 30_000);
	});

	it('seeks while playing and while paused', () => {
		clock.replay(STORM, 4);
		wall += 1000;
		clock.seek(STORM + 3_600_000);
		expect(clock.time()).toBe(STORM + 3_600_000);
		wall += 1000;
		expect(clock.time()).toBe(STORM + 3_604_000);

		clock.pause();
		clock.seek(STORM);
		wall += 1000;
		expect(clock.time()).toBe(STORM);
	});

	it('rejects invalid speeds', () => {
		expect(() => clock.replay(STORM, 0)).toThrow(RangeError);
		clock.replay(STORM);
		expect(() => clock.setSpeed(-1)).toThrow(RangeError);
		expect(() => clock.setSpeed(Number.NaN)).toThrow(RangeError);
	});

	it('holds at the present instead of running into the future', () => {
		clock.replay(T0 - 60_000, 3600);
		expect(clock.atPresent()).toBe(false);
		wall += 1000;
		expect(clock.time()).toBe(wall);
		expect(clock.atPresent()).toBe(true);
		wall += 1000;
		expect(clock.time()).toBe(wall);
	});

	it('clamps starts and seeks to the present', () => {
		clock.replay(T0 + 3_600_000);
		expect(clock.time()).toBe(T0);
		clock.pause();
		clock.seek(T0 + 60_000);
		wall += 5000;
		expect(clock.time()).toBe(T0);
	});

	it('returns to the wall clock when going live', () => {
		clock.replay(STORM, 60);
		clock.pause();
		clock.live();
		expect(clock.time()).toBe(T0);
		expect(clock.playing).toBe(true);
		expect(clock.speed).toBe(1);
	});
});

describe('render', () => {
	it('moves only by fixed steps, whatever the wall clock does', () => {
		clock.render(STORM, 1000 / 30);
		wall += 60_000;
		expect(clock.time()).toBe(STORM);
		for (let i = 0; i < 30; i++) clock.advance();
		expect(clock.time()).toBe(STORM + 1000);
	});

	it('produces the same sequence on every run', () => {
		const run = () => {
			const c = new SceneClock(() => Math.random());
			c.render(STORM, 40);
			return Array.from({ length: 5 }, () => c.advance());
		};
		expect(run()).toEqual(run());
	});

	it('seeks to an exact time', () => {
		clock.render(STORM, 40);
		clock.advance();
		clock.seek(STORM + 10_000);
		expect(clock.advance()).toBe(STORM + 10_040);
	});

	it('rejects a non-positive step and replay controls', () => {
		expect(() => clock.render(STORM, 0)).toThrow(RangeError);
		clock.render(STORM, 40);
		expect(() => clock.play()).toThrow();
		expect(() => clock.setSpeed(2)).toThrow();
	});

	it('refuses advance outside render mode', () => {
		expect(() => clock.advance()).toThrow();
	});
});

describe('events', () => {
	it('emits mode changes once per actual change', () => {
		const onMode = vi.fn();
		clock.on('mode', onMode);
		clock.live();
		clock.replay(STORM);
		clock.replay(STORM + 1000);
		clock.render(STORM, 40);
		clock.live();
		expect(onMode.mock.calls).toEqual([['replay'], ['render'], ['live']]);
	});

	it('emits seeks with the target time, and stops after unsubscribing', () => {
		const onSeek = vi.fn();
		const off = clock.on('seek', onSeek);
		clock.replay(STORM);
		clock.seek(STORM + 5000);
		off();
		clock.seek(STORM);
		expect(onSeek.mock.calls).toEqual([[STORM + 5000]]);
	});
});
