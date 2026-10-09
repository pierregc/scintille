import { describe, expect, it } from 'vitest';
import { IDLE_DELAY_MS, IdleRotation } from './idle';

describe('IdleRotation', () => {
	it('rotates on arrival', () => {
		expect(new IdleRotation().rotating(0)).toBe(true);
	});

	it('stops as soon as an interaction starts', () => {
		const idle = new IdleRotation();
		idle.start(1000);
		expect(idle.rotating(1000)).toBe(false);
	});

	it('stays stopped during a long interaction', () => {
		const idle = new IdleRotation();
		idle.start(0);
		expect(idle.rotating(10 * IDLE_DELAY_MS)).toBe(false);
	});

	it('resumes 20 s after the last interaction ends', () => {
		const idle = new IdleRotation();
		idle.start(0);
		idle.end(5000);
		expect(idle.rotating(5000 + IDLE_DELAY_MS - 1)).toBe(false);
		expect(idle.rotating(5000 + IDLE_DELAY_MS)).toBe(true);
	});

	it('restarts the delay on each new interaction', () => {
		const idle = new IdleRotation();
		idle.start(0);
		idle.end(0);
		idle.start(15_000);
		idle.end(15_000);
		expect(idle.rotating(IDLE_DELAY_MS)).toBe(false);
		expect(idle.rotating(15_000 + IDLE_DELAY_MS)).toBe(true);
	});

	it('accepts a custom delay', () => {
		const idle = new IdleRotation(100);
		idle.start(0);
		idle.end(0);
		expect(idle.rotating(100)).toBe(true);
	});
});
