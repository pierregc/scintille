import type { StormSearchResponse } from '../../contract/types';
import type { GlobeApp } from '../../globe/app';
import { GLOBE_GONE, GLOBE_READY } from '../../globe/island';
import { SearchRequests } from '../../storms/search-client';
import { parseQuery } from '../../storms/search-query';

export function mountStormBrowser(root: HTMLDetailsElement) {
	const form = root.querySelector<HTMLFormElement>('form');
	const status = root.querySelector<HTMLElement>('[data-catalog-status]');
	const list = root.querySelector<HTMLOListElement>('[data-storm-cards]');
	const next = root.querySelector<HTMLButtonElement>('[data-browser-next]');
	const previous = root.querySelector<HTMLButtonElement>('[data-browser-previous]');
	const dateStatus = root.querySelector<HTMLElement>('[data-query-dates]');
	if (!form || !status || !list || !next || !previous || !dateStatus) return;
	let app: GlobeApp | undefined;
	const requests = new SearchRequests();
	let submitted = new URLSearchParams();
	let pages: { cursor: string | null; result: StormSearchResponse }[] = [];
	let current = -1;
	let loadedAt = 0;
	let detachReplay: (() => void) | undefined;
	const cancel = () => requests.cancel();
	const close = (focus = false) => {
		root.open = false; cancel(); app?.discovery?.setVisible(false);
		if (focus) root.querySelector('summary')?.focus();
	};
	const openResult = async (slug: string) => {
		const owner = app;
		if (!owner) return;
		close();
		if (await owner.replay.open(slug) && owner === app) document.querySelector<HTMLButtonElement>('[data-play]')?.focus();
	};
	const render = (result: StormSearchResponse) => {
		list.replaceChildren();
		result.storms.forEach((storm, index) => {
			const item = document.createElement('li');
			item.dataset.slug = storm.slug;
			const title = document.createElement('strong'); title.textContent = `${index + 1} · ${storm.label}`;
			const when = document.createElement('p'); when.textContent = `${new Date(storm.t_start).toISOString().replace('T', ' ').replace('.000Z', ' UTC')} – ${new Date(storm.t_end).toISOString().slice(11, 16)} UTC`;
			const metrics = document.createElement('p'); metrics.textContent = `${storm.level_name} electrical activity · ${storm.flashes.toLocaleString('en')} flashes · peak ${storm.peak_rate.toLocaleString('en')}/min`;
			const replay = document.createElement('button'); replay.type = 'button'; replay.textContent = 'Replay';
			replay.addEventListener('click', () => { void openResult(storm.slug); });
			item.addEventListener('pointerenter', () => app?.discovery?.highlight(storm.slug));
			item.addEventListener('pointerleave', () => app?.discovery?.highlight(null));
			item.addEventListener('focusin', () => app?.discovery?.highlight(storm.slug));
			item.addEventListener('focusout', () => app?.discovery?.highlight(null));
			item.append(title, when, metrics, replay);
			if (result.page_links_available) { const link = document.createElement('a'); link.href = `/storms/${storm.slug}`; link.textContent = 'Storm details'; item.append(link); }
			list.append(item);
		});
		app?.discovery?.setResults(result.storms);
		next.disabled = !result.next_cursor;
		next.textContent = result.storms.length ? 'Next' : 'Continue searching';
		previous.disabled = current <= 0;
		const stale = Date.now() - Date.parse(result.catalog_checked_at) > 86400000;
		status.textContent = `${result.storms.length ? `${result.storms.length} results on this page.` : result.exhausted ? (submitted.size ? (pages.slice(0, current).some(page => page.result.storms.length) ? 'No further published storms match these filters.' : 'No published storms match these filters.') : 'No published storm replays are available yet.') : 'No matches in this batch. Continue searching or refine your filters.'} Catalog checked ${new Date(result.catalog_checked_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.${result.generation !== result.current_generation ? ' Earlier catalog version. Refresh to use the current catalog.' : stale ? ' Recent storms may be missing.' : ''}`;
		dateStatus.textContent = result.query.start || result.query.end ? `Storm start (UTC): ${result.query.start ?? 'any'} → ${result.query.end ?? 'any'} (end excluded)` : '';
	};
	const load = async (cursor: string | null = null, append = false) => {
		if (!app || !root.open) return;
		cancel();
		const params = new URLSearchParams(submitted);
		if (cursor) params.set('cursor', cursor);
		status.textContent = 'Loading published storms…';
		next.disabled = true;
		try {
			const result = await requests.load(params);
			if (!result || !root.open) return;
			if (!append) pages = [];
			else pages = pages.slice(0, current + 1);
			pages.push({ cursor, result });
			if (pages.length > 5) pages.shift();
			current = pages.length - 1; loadedAt = Date.now(); render(result);
		} catch (error) {
			status.textContent = `${error instanceof Error ? error.message : 'The storm catalog is unavailable.'}${pages[current] ? ' Showing previous confirmed results.' : ''}`;
			if (pages[current]) next.disabled = !pages[current].result.next_cursor;
		}
	};
	form.addEventListener('submit', event => {
		event.preventDefault();
		const params = new URLSearchParams();
		for (const [key, value] of new FormData(form)) if (typeof value === 'string' && value && key !== 'period') params.set(key, value);
		const period = new FormData(form).get('period');
		if (period === '7' || period === '30') {
			const today = new Date(); today.setUTCHours(0, 0, 0, 0);
			params.set('from', new Date(today.getTime() - (Number(period) - 1) * 86400000).toISOString().slice(0, 10));
			params.set('to', new Date(today.getTime() + 86400000).toISOString().slice(0, 10));
		}
		try {
			const parsed = parseQuery(params);
			if (/\b\d{4}-\d{2}(?:-\d{2})?\b/.test(params.get('q') ?? '')) {
				(form.elements.namedItem('period') as HTMLSelectElement).value = 'custom';
				(form.elements.namedItem('from') as HTMLInputElement).value = parsed.start?.slice(0, 10) ?? '';
				(form.elements.namedItem('to') as HTMLInputElement).value = parsed.end?.slice(0, 10) ?? '';
				form.dispatchEvent(new Event('change'));
			}
		} catch (error) { status.textContent = (error as Error).message; return; }
		submitted = params; pages = []; current = -1; list.replaceChildren(); app?.discovery?.setResults([]); void load();
	});
	form.addEventListener('change', event => {
		const name = (event.target as HTMLInputElement | null)?.name ?? '';
		if (['period', 'from', 'to'].includes(name)) {
			const text = form.elements.namedItem('q') as HTMLInputElement;
			text.value = text.value.replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, '').trim();
		}
		const custom = new FormData(form).get('period') === 'custom';
		const dates = root.querySelector<HTMLElement>('[data-custom-dates]'); if (dates) dates.hidden = !custom;
		for (const name of ['from', 'to']) (form.elements.namedItem(name) as HTMLInputElement).disabled = !custom;
	});
	for (const name of ['from', 'to']) (form.elements.namedItem(name) as HTMLInputElement).disabled = true;
	form.addEventListener('reset', () => { queueMicrotask(() => { form.dispatchEvent(new Event('change')); form.requestSubmit(); }); });
	root.querySelector('[data-browser-close]')?.addEventListener('click', () => close(true));
	root.querySelector('[data-catalog-retry]')?.addEventListener('click', () => { void load(); });
	next.addEventListener('click', () => { const cursor = pages[current]?.result.next_cursor; if (cursor) void load(cursor, true); });
	previous.addEventListener('click', () => { cancel(); if (current > 0) render(pages[--current].result); });
	root.addEventListener('keydown', event => { if (event.key === 'Escape') close(true); });
	root.addEventListener('toggle', () => {
		if (!root.open) { cancel(); app?.discovery?.setVisible(false); return; }
		const info = document.querySelector<HTMLDetailsElement>('[data-info]'); if (info) info.open = false;
		if (app?.replay.state.loading) { close(); return; }
		app?.discovery?.setVisible(true);
		if (pages[current] && Date.now() - loadedAt < 60000) render(pages[current].result); else void load();
	});
	const info = document.querySelector<HTMLDetailsElement>('[data-info]');
	info?.addEventListener('toggle', () => { if (info.open) close(); });
	window.addEventListener(GLOBE_READY, event => {
		detachReplay?.();
		app = (event as CustomEvent<GlobeApp>).detail;
		detachReplay = app.replay.onEntry(() => { if (root.open) close(); });
		root.hidden = false;
		app.discovery?.onSelect(slug => { void openResult(slug); });
		app.discovery?.onGroup(slugs => {
			const rows = Array.from(list.children) as HTMLElement[];
			for (const row of rows) row.style.outline = slugs.includes(row.dataset.slug ?? '') ? '1px solid var(--hair)' : '';
			status.textContent = `${slugs.length} locations overlap. Their rows are outlined below.`;
			const row = rows.find(item => slugs.includes(item.dataset.slug ?? ''));
			row?.scrollIntoView({ block: 'nearest' }); row?.querySelector('button')?.focus();
		});
		if (root.open) { app.discovery?.setVisible(true); void load(); }
	});
	window.addEventListener(GLOBE_GONE, () => { detachReplay?.(); close(); app = undefined; root.hidden = true; pages = []; current = -1; list.replaceChildren(); });
	window.addEventListener('pagehide', () => { cancel(); detachReplay?.(); }, { once: true });
}
