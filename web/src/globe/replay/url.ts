import { type CameraView, FLIGHT } from '../flight';

export interface ReplayLocation {
	slug: string;
	time?: number;
	speed: number;
	paused: boolean;
	view?: CameraView;
}

const KEYS = ['storm', 'time', 'speed', 'paused', 'view'];
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** Invalid optional values use defaults; an invalid slug falls back to the current/live scene. */
export function parseReplayLocation(url: URL): ReplayLocation | null {
	const slug = url.searchParams.get('storm');
	if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 256) return null;
	const requestedSpeed = Number(url.searchParams.get('speed') ?? 60);
	const speed = Number.isFinite(requestedSpeed) && requestedSpeed > 0 && requestedSpeed <= 3600 ? requestedSpeed : 60;
	const stamp = url.searchParams.get('time') ?? '';
	let time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(stamp) ? Date.parse(stamp) : NaN;
	if (Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) !== stamp.slice(0, 19)) time = NaN;
	const rawView = url.searchParams.get('view');
	const fields = rawView?.split(',');
	let view: ReplayLocation['view'];
	if (fields && (fields.length === 4 || fields.length === 5) && fields.every((field) => field.trim() !== '' && Number.isFinite(Number(field)))) {
		const [lat, lon, altitude, tilt, heading] = fields.map(Number);
		if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
			view = { lat, lon, altitude: clamp(altitude, 20, 200_000), tilt: clamp(tilt, 0, FLIGHT.maxTiltDeg + FLIGHT.maxGazeDeg) };
			if (heading !== undefined) view.heading = ((heading % 360) + 360) % 360;
		}
	}
	return { slug, time: Number.isFinite(time) ? time : undefined, speed, paused: url.searchParams.get('paused') === '1', view };
}

/** Preserve quality/debug and unrelated query parameters; replay owns only its explicit keys. */
export function replayUrl(base: URL, state: ReplayLocation | null): URL {
	const url = new URL(base);
	for (const key of KEYS) url.searchParams.delete(key);
	if (!state) return url;
	url.searchParams.set('storm', state.slug);
	if (state.time !== undefined) url.searchParams.set('time', new Date(state.time).toISOString());
	url.searchParams.set('speed', String(state.speed));
	if (state.paused) url.searchParams.set('paused', '1');
	if (state.view) {
		const { lat, lon, altitude, tilt, heading = 0 } = state.view;
		const fields = [lat.toFixed(5), lon.toFixed(5), altitude.toFixed(3), tilt.toFixed(3)];
		if (Math.abs(((heading + 180) % 360) - 180) >= 5e-4) fields.push(heading.toFixed(3));
		url.searchParams.set('view', fields.join(','));
	}
	return url;
}
