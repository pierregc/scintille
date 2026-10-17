import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../fixtures/storms/2026-07-15-orlando.json';
import type { StormDetail } from '../../contract/types';
import { SceneClock } from '../clock';
import { StormReplay } from './index';
import { ReplayNavigation, type NavigationHost } from './navigation';

function setup(search: string, initialView?: NavigationHost['initialView']) {
	let url = new URL(`https://scintille.app/${search}`);
	let pop = () => {};
	const writes: { url: URL; push: boolean }[] = [];
	const clock = new SceneClock(() => 1000);
	const data = {
		openStorm: vi.fn().mockImplementation(async (_base: string, slug: string, speed: number) => {
			if (slug === 'unknown' || slug.includes('/')) throw new Error('missing');
			clock.replay(Date.parse(fixture.storm.t_start), speed);
			return { ...fixture, storm: { ...fixture.storm, slug } } as StormDetail;
		}),
		live: vi.fn().mockImplementation(async () => { clock.live(); }),
	};
	let view = { lat: 28.5, lon: -81.3, altitude: 2000, tilt: 12 };
	const controls = { cancelFlight: vi.fn(), view: () => view, flyTo: vi.fn().mockImplementation(async (options) => { view = { ...view, ...options }; return true; }) };
	const replay = new StormReplay(data, clock, controls, 'https://feed.test/', () => ({ fov: 35, aspect: 1 }));
	const host: NavigationHost = { initialView, url: () => url, write: (next, push) => { url = next; writes.push({ url, push }); }, onPop: (listener) => { pop = listener; return () => { pop = () => {}; }; } };
	const navigation = new ReplayNavigation(replay, clock, controls, host);
	return { navigation, replay, clock, data, controls, writes, url: () => url, setUrl: (search: string) => { url = new URL(`https://scintille.app/${search}`); }, pop: () => pop(), dispose: () => { navigation.dispose(); replay.dispose(); } };
}

describe('replay browser navigation', () => {
	it('restores the requested instant/view paused and clamps times to the published interval', async () => {
		const x = setup('?storm=2026-07-15-orlando&time=2099-01-01T00:00:00Z&view=10,20,500,30&paused=1&quality=low');
		try {
			await x.navigation.restore();
			expect(x.clock.time()).toBe(Date.parse(fixture.storm.t_end));
			expect(x.clock.playing).toBe(false);
			expect(x.controls.view()).toMatchObject({ lat: 10, lon: 20, altitude: 500, tilt: 30 });
			expect(x.url().searchParams.get('quality')).toBe('low');
			expect(x.writes.every((write) => !write.push)).toBe(true);
		} finally { x.dispose(); }
	});
	it('pushes explicit storm/live actions, replaces seeks/speeds, and restores same-storm history without another download', async () => {
		const x = setup('?quality=high');
		try {
			await x.navigation.restore();
			await x.replay.open(fixture.storm.slug);
			expect(x.writes.at(-1)?.push).toBe(true);
			x.clock.seek(Date.parse('2026-07-15T18:01:00Z'));
			x.clock.setSpeed(600);
			expect(x.url().searchParams.get('speed')).toBe('600');
			expect(x.writes.at(-1)?.push).toBe(false);
			const shared = new URL(x.navigation.shareUrl());
			expect(shared.searchParams.get('paused')).toBe('1');
			expect(shared.searchParams.get('time')).toBe('2026-07-15T18:01:00.000Z');
			x.setUrl('?storm=2026-07-15-orlando&time=2026-07-15T18:00:30Z&paused=1');
			await x.navigation.restore();
			expect(x.data.openStorm).toHaveBeenCalledOnce();
			expect(x.clock.time()).toBe(Date.parse('2026-07-15T18:00:30Z'));
			await x.replay.live();
			expect(x.url().searchParams.has('storm')).toBe(false);
			expect(x.writes.at(-1)?.push).toBe(true);
		} finally { x.dispose(); }
	});
	it.each(['navigation', 'selection'])('reframes on reload after an interrupted %s entry while explicit sharing keeps its view', async (entry) => {
		const x = setup(entry === 'navigation' ? `?storm=${fixture.storm.slug}` : '');
		try {
			x.controls.flyTo.mockResolvedValueOnce(false);
			if (entry === 'navigation') await x.navigation.restore();
			else await x.replay.open(fixture.storm.slug);
			x.clock.pause();
			x.clock.seek(Date.parse('2026-07-15T18:00:30Z'));
			x.clock.setSpeed(30);
			expect(x.url().searchParams.has('view')).toBe(false);
			const reload = setup(x.url().search);
			try {
				await reload.navigation.restore();
				expect(reload.controls.flyTo).toHaveBeenCalledWith(expect.objectContaining({ duration: 2800 }));
				expect(reload.clock.time()).toBe(Date.parse('2026-07-15T18:00:30Z'));
				expect(reload.clock.speed).toBe(30);
				expect(reload.clock.playing).toBe(false);
			} finally { reload.dispose(); }
			const shared = new URL(x.navigation.shareUrl());
			expect(shared.searchParams.has('view')).toBe(true);
			const sharedSession = setup(shared.search);
			try {
				await sharedSession.navigation.restore();
				expect(sharedSession.controls.flyTo).toHaveBeenCalledWith(expect.objectContaining({ duration: 0 }), { preserveRange: true });
				expect(sharedSession.controls.view()).toMatchObject(x.controls.view());
			} finally { sharedSession.dispose(); }
		} finally { x.dispose(); }
	});

	it('keeps ordinary reloads on storm framing after arrival and later camera changes', async () => {
		const x = setup(`?storm=${fixture.storm.slug}&quality=high`);
		try {
			await x.navigation.restore();
			expect(x.url().searchParams.has('view')).toBe(false);
			const moved = { lat: 20, lon: -70, altitude: 4000, tilt: 30 };
			x.controls.view = () => moved;
			x.clock.pause();
			x.clock.setSpeed(30);
			expect(x.url().searchParams.has('view')).toBe(false);
			expect(x.url().searchParams.get('quality')).toBe('high');
			await x.navigation.restore();
			expect(x.controls.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 2800, lat: 28.5 }));
			const shared = new URL(x.navigation.shareUrl());
			x.setUrl(shared.search);
			await x.navigation.restore();
			expect(x.controls.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ ...moved, duration: 0 }), { preserveRange: true });
			x.clock.setSpeed(60);
			expect(x.url().searchParams.get('view')).toBe(shared.searchParams.get('view'));
		} finally { x.dispose(); }
	});

	it('restores a verified final-frame checkpoint only on the first load and keeps it out of the URL', async () => {
		const view = { lat: 28.5, lon: -81.3, altitude: 306, tilt: 12 };
		const checkpoint = vi.fn(() => view);
		const x = setup(`?storm=${fixture.storm.slug}`, checkpoint);
		try {
			await x.navigation.restore();
			expect(checkpoint).toHaveBeenCalledWith(fixture.storm.slug);
			expect(x.controls.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ ...view, lon: expect.closeTo(-81.3, 5), altitude: expect.closeTo(306, 3), duration: 0 }));
			expect(x.url().searchParams.has('view')).toBe(false);
			await x.navigation.restore();
			expect(checkpoint).toHaveBeenCalledOnce();
			expect(x.controls.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 2800 }));
		} finally { x.dispose(); }
	});

	it('reframes normally if the remembered camera no longer matches the storm bounds', async () => {
		const x = setup(`?storm=${fixture.storm.slug}`, () => ({ lat: 0, lon: 0, altitude: 5000, tilt: 0 }));
		try {
			await x.navigation.restore();
			expect(x.controls.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 2800, lat: 28.5 }));
		} finally { x.dispose(); }
	});

	it('gives an explicit shared camera priority over a reload checkpoint', async () => {
		const checkpoint = vi.fn(() => ({ lat: 0, lon: 0, altitude: 5000, tilt: 0 }));
		const x = setup(`?storm=${fixture.storm.slug}&view=10,20,500,30&paused=1`, checkpoint);
		try {
			await x.navigation.restore();
			expect(checkpoint).not.toHaveBeenCalled();
			expect(x.controls.flyTo).toHaveBeenLastCalledWith({ lat: 10, lon: 20, altitude: 500, tilt: 30, duration: 0 }, { preserveRange: true });
			expect(x.url().searchParams.has('view')).toBe(true);
		} finally { x.dispose(); }
	});

	it.each(['unknown', '../bad'])('keeps a usable scene and visible error for invalid/unavailable storm %s', async (slug) => {
		const x = setup(`?storm=${slug}`);
		try {
			await x.navigation.restore();
			expect(x.clock.mode).toBe('live');
			expect(x.replay.state.error).toContain('could not be opened');
			expect(x.url().searchParams.has('storm')).toBe(false);
		} finally { x.dispose(); }
	});
	it('ignores obsolete URL restoration after a user returns to live', async () => {
		const x = setup('?storm=slow');
		let resolve!: (value: StormDetail | null) => void;
		x.data.openStorm.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		const restoring = x.navigation.restore();
		await x.replay.live();
		resolve(null);
		await restoring;
		expect(x.url().searchParams.has('storm')).toBe(false);
		expect(x.replay.state.selected).toBeNull();
		x.dispose();
	});
	it('unsubscribes browser events on disposal', async () => {
		const x = setup('');
		x.dispose(); x.pop();
		await Promise.resolve();
		expect(x.data.openStorm).not.toHaveBeenCalled();
	});
});
