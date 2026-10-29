import {
	ClampToEdgeWrapping,
	DataArrayTexture,
	LinearFilter,
	LinearMipmapLinearFilter,
	RGBAFormat,
	SRGBColorSpace,
	Texture,
	UnsignedByteType,
	Vector3,
	type WebGLRenderer,
} from 'three';

/** Mip sizes of a square texture, level 0 first. */
export function mipSizes(size: number): number[] {
	const sizes = [size];
	while (sizes[sizes.length - 1] > 1) sizes.push(Math.max(1, sizes[sizes.length - 1] >> 1));
	return sizes;
}

/** Free layers of a texture array, lowest first. */
export class LayerPool {
	#free: number[];

	constructor(readonly size: number) {
		this.#free = Array.from({ length: size }, (_, i) => size - 1 - i);
	}

	get used(): number {
		return this.size - this.#free.length;
	}

	take(): number | null {
		return this.#free.pop() ?? null;
	}

	give(layer: number): void {
		if (layer < 0 || layer >= this.size || this.#free.includes(layer)) return;
		this.#free.push(layer);
		this.#free.sort((a, b) => b - a);
	}
}

export type AtlasRenderer = Pick<WebGLRenderer, 'initTexture' | 'copyTextureToTexture'>;

/** An empty sRGB array texture standing in until the tiles are allocated. */
export function emptyArray(): DataArrayTexture {
	const texture = new DataArrayTexture(new Uint8Array(4), 1, 1, 1);
	texture.colorSpace = SRGBColorSpace;
	texture.needsUpdate = true;
	return texture;
}

/**
 * Surface tiles in one sRGB texture array with mipmaps. Each tile goes to the GPU through a
 * scratch texture whose mipmaps the GPU builds, then every level is copied into the tile's layer.
 */
export class TileAtlas {
	readonly texture: DataArrayTexture;
	#scratch = new Texture();
	#pool: LayerPool;
	#levels: number;
	#at = new Vector3();

	constructor(private readonly renderer: AtlasRenderer, readonly layers: number, readonly size: number, anisotropy: number) {
		const sizes = mipSizes(size);
		this.#levels = sizes.length;
		this.#pool = new LayerPool(layers);
		const texture = new DataArrayTexture(null, size, size, layers);
		texture.format = RGBAFormat;
		texture.type = UnsignedByteType;
		texture.colorSpace = SRGBColorSpace;
		texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
		texture.magFilter = LinearFilter;
		texture.minFilter = LinearMipmapLinearFilter;
		texture.anisotropy = anisotropy;
		texture.generateMipmaps = false;
		// Only the number of levels counts: storage is allocated, nothing is uploaded.
		texture.mipmaps = sizes.map((s) => ({ data: new Uint8Array(0), width: s, height: s }));
		texture.source.dataReady = false;
		texture.needsUpdate = true;
		renderer.initTexture(texture);
		this.texture = texture;

		const scratch = this.#scratch;
		scratch.colorSpace = SRGBColorSpace;
		scratch.flipY = false;
		scratch.generateMipmaps = true;
		scratch.minFilter = LinearMipmapLinearFilter;
		scratch.wrapS = scratch.wrapT = ClampToEdgeWrapping;
	}

	get used(): number {
		return this.#pool.used;
	}

	/** Copies a decoded tile into a free layer; null when every layer holds a tile. */
	upload(image: ImageBitmap): number | null {
		if (image.width !== this.size || image.height !== this.size) return null;
		const layer = this.#pool.take();
		if (layer === null) return null;
		this.#scratch.image = image;
		this.#scratch.needsUpdate = true;
		this.renderer.initTexture(this.#scratch);
		this.#at.set(0, 0, layer);
		for (let level = 0; level < this.#levels; level++) {
			this.renderer.copyTextureToTexture(this.#scratch, this.texture, null, this.#at, level, level);
		}
		return layer;
	}

	free(layer: number): void {
		this.#pool.give(layer);
	}

	dispose(): void {
		this.texture.dispose();
		this.#scratch.dispose();
	}
}
