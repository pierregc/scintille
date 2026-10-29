export interface Track {
	id: string;
	/** Seconds of seamless loop, after the file's lead-in. */
	loop: number;
}

/** Seconds a track plays before the next one fades in. */
export const RELAY_S = 90;
export const CROSSFADE_S = 8;

/** A random track, never the one playing, so the relay never repeats itself. */
export function nextTrack<T extends Track>(tracks: readonly T[], current: T | null, random = Math.random): T {
	if (tracks.length === 0) throw new RangeError('no tracks');
	const pool = tracks.filter((t) => t !== current);
	if (pool.length === 0) return tracks[0];
	return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}
