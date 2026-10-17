import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../fixtures/storms/2026-07-15-orlando.json';
import type { StormDetail } from '../../contract/types';
import { SceneClock } from '../clock';
import { StormReplay } from './index';
import { ReplayNavigation, type NavigationHost } from './navigation';

function setup(search: string) {
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
	const host: NavigationHost = { url: () => url, write: (next, push) => { url = next; writes.push({ url, push }); }, onPop: (listener) => { pop = listener; return () => { pop = () => {}; }; } };
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
