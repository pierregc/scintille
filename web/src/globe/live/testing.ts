import type { ChunkRef, LiveManifest } from '../../contract/types';
import type { Visibility } from './client';

export interface FakeFlash {
	offsetMs: number;
	lat: number;
	lon: number;
}

/** Encodes a chunk as the pipeline does, uncompressed. */
export function encodeChunk(startSeconds: number, flashes: FakeFlash[], major = 2): Uint8Array<ArrayBuffer> {
	const n = flashes.length;
	const buffer = new ArrayBuffer(16 + n * (4 + 2 + 2 + 2 + 2 + 1 + 1 + 1));
	const view = new DataView(buffer);
	[0x53, 0x43, 0x4e, 0x54].forEach((byte, i) => view.setUint8(i, byte));
	view.setUint8(4, major);
	view.setUint32(8, startSeconds, true);
	view.setUint32(12, n, true);
	let offset = 16;
	const column = <T extends { set(values: ArrayLike<number>): void; byteLength: number }>(
		Type: new (b: ArrayBuffer, o: number, l: number) => T,
		values: number[],
	) => {
		const array = new Type(buffer, offset, n);
		array.set(values);
		offset += array.byteLength;
	};
	column(Int32Array, flashes.map((f) => f.offsetMs));
	column(Int16Array, flashes.map((f) => Math.round(f.lat / 0.0027466658528397473)));
	column(Int16Array, flashes.map((f) => Math.round(f.lon / 0.005493331705679495)));
	column(Uint16Array, flashes.map(() => 100));
	column(Uint16Array, flashes.map(() => 250));
	column(Uint8Array, flashes.map(() => 255));
	column(Uint8Array, flashes.map((_, i) => i % 3));
	column(Uint8Array, flashes.map(() => 0));
	return new Uint8Array(buffer);
}

export async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** In-memory feed served through a fake `fetch` that records every request. */
export class FakeFeed {
	readonly requests: string[] = [];
	readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
	chunks: ChunkRef[] = [];
	majorVersion = 2;
	failing = false;
	/** Serves the manifest but fails every chunk download. */
	failingChunks = false;

	/** Publishes a chunk of `count` flashes; durations and names are deliberately irregular. */
	async publish(startSeconds: number, durationSeconds: number, count: number, major = 2): Promise<ChunkRef> {
		const path = `chunks/c${startSeconds}-${this.chunks.length}.bin.gz`;
		const flashes = Array.from({ length: count }, (_, i) => ({ offsetMs: -30_000 + i, lat: i % 90, lon: -i % 180 }));
		this.files.set(path, await gzip(encodeChunk(startSeconds, flashes, major)));
		const ref: ChunkRef = {
			start: new Date(startSeconds * 1000).toISOString(),
			end: new Date((startSeconds + durationSeconds) * 1000).toISOString(),
			path,
			flash_count: count,
			size_bytes: this.files.get(path)?.byteLength ?? 0,
			event_min: null,
			event_max: null,
		};
		this.chunks.push(ref);
		return ref;
	}

	/** Drops chunks that left the manifest window. */
	expire(keep: number): void {
		this.chunks = this.chunks.slice(-keep);
	}

	manifest(): LiveManifest {
		return {
			schema_version: `${this.majorVersion}.0.0` as LiveManifest['schema_version'],
			generated_at: this.chunks.at(-1)?.end ?? '2026-07-15T18:00:00Z',
			chunk_seconds: 30,
			window_seconds: 3600,
			chunks: this.chunks,
			sources: [],
		};
	}

	chunkRequests(): string[] {
		return this.requests.filter((url) => url.includes('/chunks/'));
	}

	manifestRequests(): number {
		return this.requests.filter((url) => url.endsWith('manifest.json')).length;
	}

	fetch: typeof fetch = async (input) => {
		const url = String(input);
		this.requests.push(url);
		if (this.failing) return new Response('down', { status: 503 });
		const { pathname } = new URL(url);
		if (pathname === '/live/manifest.json') return Response.json(this.manifest());
		if (this.failingChunks) return new Response('down', { status: 503 });
		const file = this.files.get(pathname.replace(/^\/live\//, ''));
		return file ? new Response(file) : new Response('missing', { status: 404 });
	};
}

export class FakeVisibility implements Visibility {
	#hidden = false;
	readonly #listeners = new Set<() => void>();

	hidden(): boolean {
		return this.#hidden;
	}

	set(hidden: boolean): void {
		this.#hidden = hidden;
		for (const listener of this.#listeners) listener();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
