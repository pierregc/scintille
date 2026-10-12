import { INTENSITY, intensityBrightness, intensityScale } from '../../globe/lightning/intensity';

export interface LegendStep {
	intensity: number;
	/** Dot diameter, CSS px. */
	size: number;
	/** Dot opacity: the flash brightness encoded to sRGB, as it reaches the screen. */
	alpha: number;
}

/** Evenly spaced intensities drawn with the same mapping as the globe, weakest first. */
export function legendSteps(count = 5, basePx = 10): LegendStep[] {
	return Array.from({ length: count }, (_, k) => {
		const intensity = k / (count - 1);
		return {
			intensity,
			size: Math.round(basePx * intensityScale(intensity) * 10) / 10,
			alpha: Math.round(intensityBrightness(intensity) ** (1 / INTENSITY.gamma) * 100) / 100,
		};
	});
}
