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

const TEXTURES_URL: string = import.meta.env.PUBLIC_TEXTURES_URL ?? '/textures';
const TEXTURE_TIER = '4k';

export function texturesUrl(name: 'day' | 'night' | 'mask'): string {
	return `${TEXTURES_URL.replace(/\/$/, '')}/${TEXTURE_TIER}/${name}.webp`;
}

export function createEarth(renderer: WebGLRenderer, radius = 1): Earth {
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
			nightLights: { value: 1.4 },
			specular: { value: 0.6 },
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
		const texture = await loader.loadAsync(texturesUrl(name));
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
