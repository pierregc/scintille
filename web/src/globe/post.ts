import {
	CustomBlending,
	HalfFloatType,
	OneFactor,
	OneMinusDstColorFactor,
	type Object3D,
	type PerspectiveCamera,
	type Scene,
	ShaderMaterial,
	Vector2,
	WebGLRenderTarget,
	type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/** Objects on this layer glow; everything else is drawn as usual. */
export const BLOOM_LAYER = 1;

/** `radius` from afar; near the floor the bloom tightens to `nearRadius` around resolved channels. */
export const BLOOM = { strength: 0.9, radius: 0.55, nearRadius: 0.4, threshold: 0 };

export interface PostProcessing {
	render(): void;
	/** Bloom strength and radius, BLOOM.strength and BLOOM.radius by default. */
	setBloom(strength: number, radius?: number): void;
	setSize(width: number, height: number, pixelRatio: number): void;
	dispose(): void;
}

/** Adds the bloom over what is already on screen, converted to the screen's colour space. */
const addBloom = {
	uniforms: { bloomTexture: { value: null } },
	vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`,
	fragmentShader: /* glsl */ `
uniform sampler2D bloomTexture;
varying vec2 vUv;
void main() {
	gl_FragColor = vec4(texture2D(bloomTexture, vUv).rgb, 1.0);
	#include <colorspace_fragment>
}
`,
};

/**
 * Selective bloom: only `glowing` objects feed the bloom, added over the normal render. The scene
 * itself still renders straight to the screen, so its colours are unchanged.
 */
export function createPostProcessing(
	renderer: WebGLRenderer,
	scene: Scene,
	camera: PerspectiveCamera,
	glowing: Object3D[],
): PostProcessing {
	for (const object of glowing) object.layers.enable(BLOOM_LAYER);
	const size = renderer.getSize(new Vector2());

	const bloomComposer = new EffectComposer(
		renderer,
		new WebGLRenderTarget(size.x / 2, size.y / 2, { type: HalfFloatType }),
	);
	bloomComposer.renderToScreen = false;
	const bloomRender = new RenderPass(scene, camera);
	const bloom = new UnrealBloomPass(new Vector2(size.x / 2, size.y / 2), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
	bloomComposer.addPass(bloomRender);
	bloomComposer.addPass(bloom);

	const quad = new FullScreenQuad(
		// Screen blend: the bloom lights the dark sky fully but barely lifts sunlit clouds, which it would whiten.
		new ShaderMaterial({
			...addBloom,
			blending: CustomBlending,
			blendSrc: OneMinusDstColorFactor,
			blendDst: OneFactor,
			depthTest: false,
			depthWrite: false,
		}),
	);
	// Bloom only: the composer buffer also holds the flashes, already drawn by the main pass.
	(quad.material as ShaderMaterial).uniforms.bloomTexture.value = bloom.renderTargetsHorizontal[0].texture;

	return {
		render() {
			const background = scene.background;
			scene.background = null;
			camera.layers.set(BLOOM_LAYER);
			bloomComposer.render();
			camera.layers.set(0);
			scene.background = background;
			renderer.render(scene, camera);
			const autoClear = renderer.autoClear;
			renderer.autoClear = false;
			quad.render(renderer);
			renderer.autoClear = autoClear;
		},
		setBloom(strength, radius = BLOOM.radius) {
			bloom.strength = strength;
			bloom.radius = radius;
		},
		setSize(width, height, pixelRatio) {
			bloomComposer.setPixelRatio(pixelRatio);
			bloomComposer.setSize(width / 2, height / 2);
		},
		dispose() {
			bloom.dispose();
			quad.material.dispose();
			quad.dispose();
			bloomComposer.dispose();
		},
	};
}
