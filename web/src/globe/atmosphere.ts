import {
	CustomBlending,
	FrontSide,
	Mesh,
	OneFactor,
	ShaderMaterial,
	SphereGeometry,
	SrcAlphaFactor,
	ZeroFactor,
	Vector3,
} from 'three';
import { atmosphereFragmentShader, atmosphereVertexShader } from './atmosphere.glsl';
import { sunDirection } from './sun';

export interface Atmosphere {
	mesh: Mesh;
	/** Points the sun at its position for a UTC instant in milliseconds. */
	setTime(utcMs: number): void;
	dispose(): void;
}

const EARTH_RADIUS_M = 6_371_000;

/** Heights are stretched so the limb stays a few pixels wide; coefficients shrink to keep optical depths real. */
export const HEIGHT_SCALE = 2.5;

/** Earth's atmosphere in metres and per metre (Bruneton 2017 values, aerosols doubled for horizon haze). */
export const EARTH_ATMOSPHERE = {
	top: 60_000,
	rayleighHeight: 8_000,
	mieHeight: 1_200,
	rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6],
	mieScattering: 8e-6,
	mieAnisotropy: 0.8,
	ozoneAbsorption: [0.65e-6, 1.881e-6, 0.085e-6],
	ozoneCenter: 25_000,
	ozoneWidth: 15_000,
} as const;

/** Atmosphere parameters in units of the globe radius. */
export function atmosphereParameters(radius: number, heightScale = HEIGHT_SCALE) {
	const a = EARTH_ATMOSPHERE;
	const length = (m: number) => (m / EARTH_RADIUS_M) * radius * heightScale;
	const coefficient = (perM: number) => (perM * EARTH_RADIUS_M) / radius / heightScale;
	return {
		planetRadius: radius,
		atmosphereRadius: radius + length(a.top),
		rayleighHeight: length(a.rayleighHeight),
		mieHeight: length(a.mieHeight),
		rayleighScattering: new Vector3(...a.rayleighScattering.map(coefficient)),
		mieScattering: coefficient(a.mieScattering),
		mieAnisotropy: a.mieAnisotropy,
		ozoneAbsorption: new Vector3(...a.ozoneAbsorption.map(coefficient)),
		ozoneCenter: length(a.ozoneCenter),
		ozoneWidth: length(a.ozoneWidth),
	};
}

/** Scattering shell around the globe; add it as a child of the Earth mesh. */
export function createAtmosphere(radius = 1): Atmosphere {
	const parameters = atmosphereParameters(radius);
	const geometry = new SphereGeometry(parameters.atmosphereRadius, 96, 48);
	const uniforms = Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, { value }]));
	const material = new ShaderMaterial({
		vertexShader: atmosphereVertexShader,
		fragmentShader: atmosphereFragmentShader,
		uniforms: { ...uniforms, sunDirection: { value: new Vector3(1, 0, 0) }, sunIntensity: { value: 14 } },
		side: FrontSide,
		transparent: true,
		depthWrite: false,
		blending: CustomBlending,
		blendSrc: OneFactor,
		blendDst: SrcAlphaFactor,
		blendSrcAlpha: ZeroFactor,
		blendDstAlpha: OneFactor,
	});
	const mesh = new Mesh(geometry, material);

	return {
		mesh,
		setTime(utcMs) {
			material.uniforms.sunDirection.value.set(...sunDirection(new Date(utcMs)));
		},
		dispose() {
			geometry.dispose();
			material.dispose();
		},
	};
}
