import { describe, expect, it, vi } from 'vitest';
import orlando from '../../../../fixtures/storms/2026-07-15-orlando.json';
import s0 from '../../../../fixtures/storms/active/0.json';
import s1 from '../../../../fixtures/storms/active/1.json';
import s2 from '../../../../fixtures/storms/active/2.json';
import s3 from '../../../../fixtures/storms/active/3.json';
import type { StormDetail } from '../../contract/types';
import { SceneClock } from '../clock';
import type { FlyToOptions } from '../flight';
import { FakeVisibility } from '../live/testing';
import type { StormReplay } from '../replay';
import { REPLAY_FRAME } from '../replay/framing';
import { StormTrack } from '../replay/track';
import { ActiveFeed } from './active';
import { FOOTPRINT } from './footprint';
import { StormFocus } from './index';

function setup(snapshots: unknown[]) {
	let now = Date.parse(s0.published_at);
	const clock = new SceneClock(() => now);
	const queue = [...snapshots];
	const feed = new ActiveFeed({
		baseUrl: 'https://data.test/', now: () => now, visibility: new FakeVisibility(), pollIntervalMs: 1e9,
		fetch: async () => Response.json(queue.length > 1 ? queue.shift() : queue[0]),
	});
	let current = { lat: 0, lon: 0, altitude: 20000, tilt: 0, heading: 0 };
	const input = new Set<() => void>();
	const flights: FlyToOptions[] = [];
	const controls = {
		flyTo: vi.fn(async (view: FlyToOptions) => {
			flights.push(view);
			current = { lat: view.lat, lon: view.lon, altitude: view.altitude ?? current.altitude, tilt: view.tilt ?? 0, heading: view.heading ?? 0 };
			return true;
		}),
		place: vi.fn((view: FlyToOptions) => { current = { ...current, ...view } as typeof current; }),
		view: () => current,
		flying: () => false,
		onSurface: () => current.tilt > 0,
		onInput: (listener: () => void) => { input.add(listener); return () => input.delete(listener); },
		holdRotation: () => {},
		isAt: () => false,
		cancelFlight: () => {},
		centerOn: () => {},
		resize: () => {},
		update: () => {},
		dispose: () => {},
	};
	const listeners = new Set<(origin: 'user' | 'navigation') => void>();
	const replay = {
		state: { selected: null as StormDetail | null, loading: null as string | null, error: null },
		grazing: false,
		onChange: (listener: (origin: 'user' | 'navigation') => void) => { listeners.add(listener); return () => listeners.delete(listener); },
		emit: () => { for (const listener of listeners) listener('user'); },
		live: vi.fn(async () => {
			replay.state = { selected: null, loading: null, error: null };
			clock.live();
			replay.emit();
		}),
		graze: vi.fn(async () => true),
	};
	const track = new StormTrack();
	const focus = new StormFocus({
		clock, replay: replay as unknown as StormReplay, feed, controls, track,
		view: () => ({ fov: 35, aspect: 16 / 9 }),
		observedTime: () => clock.time() - (clock.mode === 'live' ? 120_000 : 0),
	});
	return {
		clock, feed, focus, replay, track, flights, controls,
		tick: (ms = 16) => { now += ms; focus.update(now); },
		at: (iso: string) => { now = Date.parse(iso); },
		input: () => { for (const l of input) l(); },
	};
}

describe('storm focus in live', () => {
	it('selects a picked cell, frames it, shows its hull and path, and forces the storm view', async () => {
		const t = setup([s0]);
		await t.feed.idle();
		expect(t.focus.pick(28.04, -82.09, 5)).toBe(true);
		expect(t.focus.live?.id).toBe('synthetic-lakeland');
		expect(t.flights.at(-1)?.tilt).toBe(REPLAY_FRAME.tilt);
		expect(t.focus.selected).toBe(true);
		t.tick();
		expect(t.focus.footprint.size).toBe(1);
		expect(t.track.group.visible).toBe(true);
		expect(t.focus.pick(-60, 0, 50)).toBe(false);
	});

	it('keeps following through a merge and says so, and stops at expiry', async () => {
		const t = setup([s1, s2, s3]);
		await t.feed.idle();
		t.focus.pick(28.03, -82.13, 5);
		t.focus.setFollow(true);
		expect(t.focus.following).toBe(true);
		t.at(s2.published_at);
		await t.feed.poll();
		t.tick();
		expect(t.focus.live).toMatchObject({ id: 'synthetic-tampa', merged: { name: 'Lakeland', at: Date.parse('2026-07-15T18:44:10Z') }, end: null });
		expect(t.focus.following).toBe(true);

		const gulf = setup([s2, s3]);
		await gulf.feed.idle();
		gulf.focus.pick(26.47, -84.55, 5);
		gulf.focus.setFollow(true);
		gulf.at(s3.published_at);
		await gulf.feed.poll();
		gulf.tick();
		expect(gulf.focus.live).toMatchObject({ id: 'synthetic-gulf-1808', end: { reason: 'expired' } });
		expect(gulf.focus.following).toBe(false);
		gulf.tick(FOOTPRINT.fadeMs + 1);
		expect(gulf.focus.footprint.size).toBe(0);
		expect(gulf.track.group.visible).toBe(true);
	});

	it('leaves following on camera input and returns to the globe', async () => {
		const t = setup([s0]);
		await t.feed.idle();
		t.focus.pick(27.95, -82.39, 5);
		t.focus.setFollow(true);
		t.input();
		expect(t.focus.following).toBe(false);
		expect(t.focus.live?.id).toBe('synthetic-tampa');
		t.focus.globe();
		expect(t.focus.live).toBeNull();
		expect(t.flights.at(-1)).toMatchObject({ tilt: 0 });
		expect(t.flights.at(-1)?.altitude).toBeGreaterThan(10000);
	});

	it('leaves no layer or selection behind across repeated live and replay transitions', async () => {
		const t = setup([s0]);
		await t.feed.idle();
		for (let i = 0; i < 20; i++) {
			t.focus.pick(27.95, -82.39, 5);
			t.focus.setFollow(true);
			t.tick();
			t.clock.replay(Date.parse('2026-07-15T18:00:00Z'), 60);
			expect(t.feed.running).toBe(false);
			expect(t.focus.live).toBeNull();
			expect(t.focus.following).toBe(false);
			t.tick();
			t.tick(FOOTPRINT.fadeMs + 1);
			expect(t.focus.footprint.size).toBe(0);
			expect(t.focus.footprint.group.children).toHaveLength(0);
			expect(t.track.group.visible).toBe(false);
			t.clock.live();
			await t.feed.idle();
			expect(t.feed.running).toBe(true);
		}
		t.focus.dispose();
		expect(t.feed.running).toBe(false);
	});
});

describe('storm focus in replay', () => {
	it('follows the open storm, draws its observed area and flies out when leaving it', async () => {
		const t = setup([s0]);
		const detail = orlando as StormDetail;
		t.clock.replay(Date.parse(detail.track[0].time) + 60_000, 60);
		t.replay.state = { selected: detail, loading: null, error: null };
		t.replay.emit();
		t.flights.length = 0;
		t.tick();
		expect(t.focus.subject?.kind).toBe('replay');
		expect(t.focus.selected).toBe(false);
		expect(t.focus.footprint.size).toBe(1);
		t.focus.setFollow(true);
		expect(t.focus.following).toBe(true);
		await t.focus.setHorizon(true);
		expect(t.focus.horizon).toBe(true);
		expect(t.replay.graze).not.toHaveBeenCalled();
		t.focus.setFollow(false);
		await t.focus.setHorizon(true);
		expect(t.replay.graze).toHaveBeenCalledWith(true);
		t.focus.globe();
		await Promise.resolve();
		expect(t.replay.live).toHaveBeenCalled();
		expect(t.flights.at(-1)).toMatchObject({ tilt: 0 });
	});
});
