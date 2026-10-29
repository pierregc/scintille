import { Texture } from 'three';
import { describe, expect, it } from 'vitest';
import type { Source } from '../contract/types';
import { positionCaption } from '../components/hud/format';
import { createClouds } from './clouds';
import { LIVE_DELAYS, NO_DELAY, SourceDelays } from './live/delay';
import fixture from './scene-time-cases.json';
import { observedTime, trackObservation, TRACK_CURRENT_MS } from './scene-time';

const ms = (iso: string) => Date.parse(iso);
const track = fixture.storm.track.map(ms);
const sources = fixture.storm.sources as Source[];

function cloudLayer() {
	const clouds = createClouds(16, { storage: null });
	for (const time of fixture.clouds.map(ms)) clouds.setFrame({ texture: new Texture({ width: 4, height: 2 }), time });
	return clouds;
}

function view(clouds: ReturnType<typeof cloudLayer>, c: (typeof fixture.cases)[number]) {
	const clock = ms(c.clock);
	const observed = observedTime(clock, c.mode === 'live' ? LIVE_DELAYS : NO_DELAY, c.storm === false ? [] : sources);
	clouds.setTime(clock);
	return {
		observed: new Date(observed).toISOString().replace('.000', ''),
		position: positionCaption(trackObservation(track, observed), observed, 'UTC'),
		clouds: clouds.frameTime === null ? null : new Date(clouds.frameTime).toISOString().replace('.000', ''),
	};
}

describe('scene time', () => {
	it.each(fixture.cases)('$name', (c) => {
		const shown = view(cloudLayer(), c);
		expect(shown.observed).toBe(c.observed);
		expect(shown.clouds).toBe(c.clouds);
		if (c.position !== undefined) expect(shown.position).toBe(c.position);
	});

	it('gives the same captions whatever the scrubbing order', () => {
		const replay = fixture.cases.filter((c) => c.mode === 'replay');
		const clouds = cloudLayer();
		const forward = replay.map((c) => view(clouds, c));
		const backward = replay.toReversed().map((c) => view(clouds, c)).toReversed();
		expect(backward).toEqual(forward);
	});

	it('measures a live storm from its slowest source and treats unknown sources as the slowest', () => {
		const delays = new SourceDelays({ 'glm-east': 1000, 'glm-west': 2000, 'mtg-li': 5000 });
		expect(observedTime(10_000, delays, ['glm-east'])).toBe(9000);
		expect(observedTime(10_000, delays, ['glm-east', 'glm-west'])).toBe(8000);
		expect(observedTime(10_000, delays, ['unknown' as Source])).toBe(5000);
		expect(observedTime(10_000, delays)).toBe(9000);
		expect(observedTime(10_000, NO_DELAY, sources)).toBe(10_000);
	});

	it('never moves the position between samples', () => {
		expect(trackObservation([], 5)).toEqual({ state: 'pending', time: null });
		expect(trackObservation([10, 20], 15)).toEqual({ state: 'current', time: 10 });
		expect(trackObservation([0], TRACK_CURRENT_MS)).toEqual({ state: 'current', time: 0 });
		expect(trackObservation([0], TRACK_CURRENT_MS + 1)).toEqual({ state: 'lost', time: 0 });
	});
});
