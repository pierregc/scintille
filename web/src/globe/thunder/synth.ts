/** Length of one synthesized thunder clap, seconds. */
export const CLAP_SECONDS = 4.5;
/** Peak of every clap, leaving headroom before the limiter. */
export const PEAK = 0.9;
const FADE_OUT_S = 0.4;
const FADE_IN_S = 0.002;

/** Small seeded PRNG (mulberry32), so every clap variant is reproducible. */
export function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One mono thunder clap: a noise crack followed by a rolling brown-noise rumble. */
export function thunderClap(sampleRate: number, seed: number, seconds = CLAP_SECONDS): Float32Array<ArrayBuffer> {
	const rand = random(seed);
	const n = Math.round(sampleRate * seconds);
	const out = new Float32Array(n);

	const crack = 0.25 + 0.6 * rand();
	const crackTau = 0.015 + 0.03 * rand();
	const attack = 0.04 + 0.12 * rand();
	const decay = 0.8 + 0.8 * rand();
	const rolls = Array.from({ length: 3 + Math.floor(rand() * 4) }, () => ({
		at: 0.1 + rand() * 2.4,
		width: 0.15 + rand() * 0.5,
		level: 0.4 + rand() * 0.6,
	}));
	const crackles = Array.from({ length: 2 + Math.floor(rand() * 4) }, () => ({
		at: rand() * 0.35,
		level: 0.2 + rand() * 0.5,
	}));

	let brown = 0;
	let prevIn = 0;
	let prevOut = 0;
	const dcPole = 1 - (2 * Math.PI * 20) / sampleRate;
	for (let i = 0; i < n; i++) {
		const t = i / sampleRate;
		const white = rand() * 2 - 1;
		brown = (brown + 0.02 * white) / 1.02;

		let roll = 0.35;
		for (const r of rolls) {
			const x = (t - r.at) / r.width;
			roll += r.level * Math.exp(-x * x);
		}
		const body = Math.min(1, t / attack) * Math.exp(-t / decay) * roll * brown * 3.5;

		let snap = crack * Math.exp(-t / crackTau);
		for (const c of crackles) if (t >= c.at) snap += c.level * crack * Math.exp(-(t - c.at) / 0.01);
		const x = body + snap * white;

		// One-pole high-pass: removes the brown-noise drift.
		prevOut = x - prevIn + dcPole * prevOut;
		prevIn = x;
		out[i] = prevOut;
	}

	let peak = 0;
	for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
	const scale = peak > 0 ? PEAK / peak : 0;
	const fadeIn = Math.max(1, Math.round(FADE_IN_S * sampleRate));
	const fadeOut = Math.max(1, Math.round(FADE_OUT_S * sampleRate));
	for (let i = 0; i < n; i++) {
		const edge = Math.min(1, i / fadeIn, (n - 1 - i) / fadeOut);
		out[i] *= scale * edge;
	}
	return out;
}

/** WaveShaper curve: identity up to `knee`, then a soft shoulder that never reaches `ceiling`. */
export function softClipCurve(size = 2049, knee = 0.7, ceiling = 0.98): Float32Array<ArrayBuffer> {
	const curve = new Float32Array(size);
	const room = ceiling - knee;
	for (let i = 0; i < size; i++) {
		const x = (i / (size - 1)) * 2 - 1;
		const a = Math.abs(x);
		const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
		curve[i] = Math.sign(x) * y;
	}
	return curve;
}
