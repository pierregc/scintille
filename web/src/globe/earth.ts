import {
	Mesh,
	NoColorSpace,
	RepeatWrapping,
	SRGBColorSpace,
	ShaderMaterial,
	SphereGeometry,
	Texture,
	TextureLoader,
	Vector3,
	Vector4,
	type WebGLRenderer,
} from 'three';
import { earthFragmentShader, earthVertexShader } from './earth.glsl';
import { sunDirection } from './sun';
import { twilightUniforms } from './twilight';

export interface Earth {
	mesh: Mesh;
	/** Points the sun at its position for a UTC instant in milliseconds. */
	setTime(utcMs: number): void;
	dispose(): void;
}

export type TextureTier = '2k' | '4k' | '8k';

/** Textures root: `PUBLIC_TEXTURES_URL`, else `public/textures` in dev and R2 in production. */
export function texturesRoot(configured: unknown = import.meta.env.PUBLIC_TEXTURES_URL, dev = import.meta.env.DEV): string {
	if (typeof configured === 'string' && configured !== '') return configured.replace(/\/$/, '');
	return dev ? '/textures' : 'https://data.scintille.app/textures/v2';
}

export function texturesUrl(name: 'day' | 'night' | 'mask', root = texturesRoot(), tier: TextureTier = '4k'): string {
	return `${root}/${tier}/${name}.webp`;
}

export function createEarth(renderer: WebGLRenderer, radius = 1, tier: TextureTier = '4k'): Earth {
	const geometry = new SphereGeometry(radius, 128, 64);
	const twilight = twilightUniforms();
	const material = new ShaderMaterial({
		vertexShader: earthVertexShader,
		fragmentShader: earthFragmentShader,
		uniforms: {
			dayMap: { value: null },
			nightMap: { value: null },
			oceanMask: { value: null },
			sunDirection: { value: new Vector3(1, 0, 0) },
			twilightEdges: { value: new Vector4(...twilight.edges) },
			twilightWeights: { value: new Vector4(...twilight.weights) },
			twilightSoftness: { value: twilight.softness },
			twilightFloor: { value: 0.12 },
			nightLights: { value: 1.2 },
			specular: { value: 1 },
			seaRoughness: { value: 0.02 },
			glintCap: { value: 0.3 },
			terminatorTint: { value: 0.5 },
		},
	});
	const mesh = new Mesh(geometry, material);
	mesh.visible = false;

	const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
	const loader = new TextureLoader();
	const textures: Texture[] = [];
	let disposed = false;

	const load = async (name: 'day' | 'night' | 'mask', srgb: boolean) => {
		const texture = await loader.loadAsync(texturesUrl(name, texturesRoot(), tier));
		texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
		texture.wrapS = RepeatWrapping;
		texture.anisotropy = anisotropy;
		textures.push(texture);
		return texture;
	};

	void Promise.all([load('day', true), load('night', true), load('mask', false)]).then(
		([day, night, mask]) => {
			if (disposed) return textures.forEach((t) => t.dispose());
			material.uniforms.dayMap.value = day;
			material.uniforms.nightMap.value = night;
			material.uniforms.oceanMask.value = mask;
			mesh.visible = true;
		},
		(error: unknown) => console.error('Earth textures failed to load', error),
	);

	return {
		mesh,
		setTime(utcMs) {
			material.uniforms.sunDirection.value.set(...sunDirection(new Date(utcMs)));
		},
		dispose() {
			disposed = true;
			textures.forEach((t) => t.dispose());
			geometry.dispose();
			material.dispose();
		},
	};
}
