import { DEFAULT_VIEW } from '../controls';
import { type QualityTier, TIERS } from '../quality';

export interface RenderView {
	lat: number;
	lon: number;
	/** Camera height above the surface point, km. */
	altitude: number;
	/** Degrees from looking straight down. */
	tilt: number;
}

/** What an offline render shows: frame `i` is the scene at `start + i * (end - start) / frames`. */
export interface RenderParams {
	start: number;
	end: number;
	frames: number;
	width: number;
	height: number;
	quality: QualityTier;
	view: RenderView;
}

export const RENDER_DEFAULTS = {
	frames: 30,
	width: 1920,
	height: 1080,
	quality: 'high' as QualityTier,
	view: { lat: DEFAULT_VIEW.lat, lon: DEFAULT_VIEW.lon, altitude: 20_000, tilt: 0 },
};

const MAX_FRAMES = 100_000;
const MAX_SIZE = 4096;

/** Reads `start`, `end` (ISO 8601 UTC), `frames`, `width`, `height`, `quality`, `lat`, `lon`, `alt` (km), `tilt`. */
export function parseRenderParams(search: string): RenderParams {
	const params = new URLSearchParams(search);
	const time = (name: string) => {
		const value = Date.parse(params.get(name) ?? '');
		if (Number.isNaN(value)) throw new RangeError(`${name} must be an ISO 8601 date`);
		return value;
	};
	const number = (name: string, fallback: number, min: number, max: number, integer = false) => {
		const raw = params.get(name);
		if (raw === null || raw === '') return fallback;
		const value = Number(raw);
		if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
			throw new RangeError(`${name} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}], got ${raw}`);
		}
		return value;
	};

	const start = time('start');
	const end = time('end');
	if (!(end > start)) throw new RangeError('end must be after start');
	const quality = params.get('quality') ?? RENDER_DEFAULTS.quality;
	if (!TIERS.includes(quality as QualityTier)) throw new RangeError(`quality must be one of ${TIERS.join(', ')}`);
	const { view } = RENDER_DEFAULTS;
	return {
		start,
		end,
		frames: number('frames', RENDER_DEFAULTS.frames, 1, MAX_FRAMES, true),
		width: number('width', RENDER_DEFAULTS.width, 1, MAX_SIZE, true),
		height: number('height', RENDER_DEFAULTS.height, 1, MAX_SIZE, true),
		quality: quality as QualityTier,
		view: {
			lat: number('lat', view.lat, -90, 90),
			lon: number('lon', view.lon, -180, 180),
			altitude: number('alt', view.altitude, 1, 1_000_000),
			tilt: number('tilt', view.tilt, 0, 90),
		},
	};
}

/** Scene time of frame `index`, UTC ms. */
export function frameTime({ start, end, frames }: Pick<RenderParams, 'start' | 'end' | 'frames'>, index: number): number {
	if (!Number.isInteger(index) || index < 0 || index >= frames) {
		throw new RangeError(`frame index must be an integer in [0, ${frames - 1}], got ${index}`);
	}
	return start + ((end - start) * index) / frames;
}
