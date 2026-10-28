import {
	BufferAttribute,
	BufferGeometry,
	Group,
	LineSegments,
	Points,
	ShaderMaterial,
	type Vector3,
} from 'three';
import { latLonToVector } from '../sun';

const CLASS_COLOURS = [
	[0.86, 0.9, 1, 0.5],
	[0.86, 0.9, 1, 0.22],
	[0.7, 0.82, 1, 0.3],
	[1, 0.93, 0.8, 0.7],
];
/** Lines float this far above the ground so the surface does not cut them. */
const LIFT_KM = 0.3;
const RADIUS_KM = 6371;

const vertexShader = /* glsl */ `
attribute vec4 colour;
uniform vec3 sunDirection;
uniform float fade;
uniform float pointSize;
varying vec4 vColour;

void main() {
	vec3 n = normalize(mat3(modelMatrix) * position);
	vec3 sun = normalize(mat3(modelMatrix) * sunDirection);
	float daylight = mix(0.35, 1.0, smoothstep(-0.1, 0.1, dot(n, sun)));
	vColour = vec4(colour.rgb, colour.a * fade * daylight);
	gl_PointSize = pointSize;
	gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
varying vec4 vColour;

void main() {
	gl_FragColor = vColour;
	#include <colorspace_fragment>
}
`;

/** Natural Earth coastlines, borders, lakes and main cities as thin lines, faded in below a few thousand km. */
export class SurfaceVectors {
	readonly group = new Group();
	#materials: ShaderMaterial[] = [];
	#geometries: BufferGeometry[] = [];
	#loading = false;
	#loaded = false;

	constructor(private readonly url: string, private readonly radius: number, private readonly sun: Vector3, private readonly pixelRatio: () => number) {}

	get loaded(): boolean {
		return this.#loaded;
	}

	update(heightKm: number): void {
		const fade = Math.min(1, Math.max(0, (9000 - heightKm) / 5000));
		if (fade > 0 && !this.#loading) void this.#load();
		for (const material of this.#materials) {
			material.uniforms.fade.value = fade;
			material.uniforms.pointSize.value = 3 * this.pixelRatio();
		}
		this.group.visible = fade > 0;
	}

	async #load() {
		this.#loading = true;
		const res = await fetch(this.url);
		if (!res.ok) return console.warn('surface vectors:', res.status);
		const buffer = await res.arrayBuffer();
		const counts = new Uint32Array(buffer, 0, CLASS_COLOURS.length);
		const values = new Int16Array(buffer, CLASS_COLOURS.length * 4);
		const r = this.radius * (1 + LIFT_KM / RADIUS_KM);
		let offset = 0;
		counts.forEach((count, cls) => {
			const vertices = cls === 3 ? count : count * 2;
			const positions = new Float32Array(vertices * 3);
			const colours = new Float32Array(vertices * 4);
			for (let i = 0; i < vertices; i++) {
				const lon = (values[offset + i * 2] / 32767) * 180;
				const lat = (values[offset + i * 2 + 1] / 32767) * 90;
				const [x, y, z] = latLonToVector(lat, lon);
				positions.set([x * r, y * r, z * r], i * 3);
				colours.set(CLASS_COLOURS[cls], i * 4);
			}
			offset += vertices * 2;
			const geometry = new BufferGeometry();
			geometry.setAttribute('position', new BufferAttribute(positions, 3));
			geometry.setAttribute('colour', new BufferAttribute(colours, 4));
			const material = new ShaderMaterial({
				vertexShader,
				fragmentShader,
				uniforms: { sunDirection: { value: this.sun }, fade: { value: 0 }, pointSize: { value: 3 } },
				transparent: true,
				depthWrite: false,
			});
			this.#geometries.push(geometry);
			this.#materials.push(material);
			const object = cls === 3 ? new Points(geometry, material) : new LineSegments(geometry, material);
			object.renderOrder = 10;
			object.frustumCulled = false;
			this.group.add(object);
		});
		this.#loaded = true;
	}

	dispose(): void {
		this.#geometries.forEach((g) => g.dispose());
		this.#materials.forEach((m) => m.dispose());
	}
}
