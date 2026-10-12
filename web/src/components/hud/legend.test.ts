import { describe, expect, it } from 'vitest';
import { INTENSITY } from '../../globe/lightning/intensity';
import { legendSteps } from './legend';

describe('legendSteps', () => {
	it('runs from the weakest to the strongest flash with the globe mapping', () => {
		const steps = legendSteps(5, 10);
		expect(steps.map((s) => s.intensity)).toEqual([0, 0.25, 0.5, 0.75, 1]);
		expect(steps[0].size).toBe(10 * INTENSITY.minScale);
		expect(steps[4]).toMatchObject({ size: 10 * INTENSITY.maxScale, alpha: 1 });
		expect(steps[0].alpha).toBeCloseTo(INTENSITY.floor ** (1 / INTENSITY.gamma), 2);
	});

	it('grows in size and opacity', () => {
		const steps = legendSteps();
		expect(steps.every((s, i) => i === 0 || (s.size > steps[i - 1].size && s.alpha > steps[i - 1].alpha))).toBe(true);
	});
});
