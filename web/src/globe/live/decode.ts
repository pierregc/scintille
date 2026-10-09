import { CHUNK_COLUMNS_BINARY_LAYOUT, SCHEMA_VERSION } from '../../contract/types';

type Layout = typeof CHUNK_COLUMNS_BINARY_LAYOUT;
type ColumnName = Layout[number]['name'];
type ArrayFor<D> = D extends 'int32'
	? Int32Array
	: D extends 'int16'
		? Int16Array
		: D extends 'uint16'
			? Uint16Array
			: Uint8Array;

/** Stored (unscaled) column values; multiply by `CHUNK_SCALES` to read them. */
export type RawColumns = { [C in Layout[number] as C['name']]: ArrayFor<C['dtype']> };

export interface DecodedChunk {
	/** Start of the ingest window, UTC milliseconds. */
	start: number;
	count: number;
	columns: RawColumns;
}

export const CONTRACT_MAJOR = Number(SCHEMA_VERSION.split('.')[0]);

export const CHUNK_SCALES = Object.fromEntries(
	CHUNK_COLUMNS_BINARY_LAYOUT.map(({ name, scale }) => [name, scale]),
) as Record<ColumnName, number>;

const HEADER_BYTES = 16;
const MAGIC = [0x53, 0x43, 0x4e, 0x54]; // SCNT
const ARRAYS = { int32: Int32Array, int16: Int16Array, uint16: Uint16Array, uint8: Uint8Array };

export class ChunkFormatError extends Error {}

/** Decodes an uncompressed chunk (see docs/data-contract.md, "Chunk encoding"). */
export function decodeChunk(buffer: ArrayBuffer): DecodedChunk {
	if (buffer.byteLength < HEADER_BYTES) throw new ChunkFormatError('chunk too short');
	const view = new DataView(buffer);
	if (MAGIC.some((byte, i) => view.getUint8(i) !== byte)) throw new ChunkFormatError('bad magic');
	const major = view.getUint8(4);
	if (major !== CONTRACT_MAJOR) {
		throw new ChunkFormatError(`chunk major version ${major}, expected ${CONTRACT_MAJOR}`);
	}
	const start = view.getUint32(8, true) * 1000;
	const count = view.getUint32(12, true);

	const columns: Partial<Record<ColumnName, ArrayBufferView>> = {};
	let offset = HEADER_BYTES;
	for (const { name, dtype } of CHUNK_COLUMNS_BINARY_LAYOUT) {
		const ArrayType = ARRAYS[dtype];
		const end = offset + count * ArrayType.BYTES_PER_ELEMENT;
		if (end > buffer.byteLength) throw new ChunkFormatError(`chunk truncated in ${name}`);
		columns[name] = new ArrayType(buffer, offset, count);
		offset = end;
	}
	return { start, count, columns: columns as RawColumns };
}

/** Fetches and gunzips a chunk; no `Content-Encoding` is involved. */
export async function fetchChunk(url: string, fetchFn: typeof fetch, signal?: AbortSignal): Promise<DecodedChunk> {
	const response = await fetchFn(url, { signal });
	if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
	const buffer = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
	return decodeChunk(buffer);
}
