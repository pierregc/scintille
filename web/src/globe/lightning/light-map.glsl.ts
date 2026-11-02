import { channelGlsl, cloudDriftGlsl } from './channel';
import { CLOUD_LIGHT, cloudPatchGlsl, patchEdgeGlsl } from './cloud-light';
import { intensityGlsl } from './intensity';
import { playbackGlsl } from './playback';
import { flashProfileGlsl, glslFloat as f, PROFILE } from './profile';

/** Splats each flash as a soft, seeded patch in a point sprite over an equirectangular window of the globe, in SphereGeometry UV angles. */
export const lightMapVertexShader = /* glsl */ `
attribute vec4 flash;
attribute vec4 flashShape;

uniform float time;
uniform float duration;
uniform float flicker;
uniform vec4 window;
uniform float splat;
uniform float level;
uniform float spreadKm;
uniform float minSplatKm;
uniform float wrap;
uniform vec2 mapSize;

varying vec2 vScale;
varying float vBrightness;
varying vec4 vPatch;
varying vec4 vLobes;

${playbackGlsl}
${channelGlsl}
${flashProfileGlsl}
${intensityGlsl}
${cloudDriftGlsl}
${patchEdgeGlsl}
${cloudPatchGlsl}
void main() {
	float sceneAge = time - flash.w;
	if (sceneAge < 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}
	vec3 d = normalize(flash.xyz);
	float seed = flashShape.w;
	int kind = flashKind(seed, flashShape.z, flashShape.y);
	bool ground = isGround(kind);
	float age = wallAge(time, flash.w);
	float lat = asin(clamp(d.y, -1.0, 1.0));
	vec2 drift = cloudDrift(age, clamp(flashShape.z / 1000.0, ${f(PROFILE.minFlicker)}, ${f(PROFILE.maxFlicker)}), flashShape.y, seed, kind) / 6371.0 * flicker;
	lat += drift.y;
	float lon = atan(-d.z, d.x) + drift.x / max(cos(lat), 0.05);
	float relative = mod(lon - window.x + 3.14159265, 6.28318531) - 3.14159265;
	// Flashes near the antimeridian of the window are drawn a second time on the other side.
	relative += wrap * (relative > 0.0 ? -6.28318531 : 6.28318531);
	vec2 center = vec2(relative, lat - window.y) / window.zw;
	float pulse = 0.0;
	float brightness = 0.0;
	if (abs(center.x) < 1.2 && abs(center.y) < 1.2) {
		pulse = flashProfile(age, sceneAge, duration, flashShape.z, seed, flicker, kind);
		brightness = pulse * intensityBrightness(flashShape.x) * onScreen(flash.w);
	}
	if (brightness <= 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}
	// The whole footprint lights on the flash's pulses, whatever its energy, a smaller patch between them, where the light has drifted; reduced motion keeps the footprint.
	float full = mix(1.0, smoothstep(${f(CLOUD_LIGHT.fullFrom)}, ${f(CLOUD_LIGHT.fullTo)}, pulse), flicker);
	float footprint = flashShape.y * splat * mix(${f(CLOUD_LIGHT.dimSplat)}, 1.0, full);
	float radiusKm = max(max(footprint, spreadKm), minSplatKm);
	float radius = radiusKm / 6371.0;
	vec2 pixels = vec2(radius / max(cos(lat), 0.05), radius) / window.zw * mapSize * 0.5;
	gl_PointSize = 2.0 * max(pixels.x, pixels.y);
	gl_Position = vec4(center, 0.0, 1.0);
	vScale = gl_PointSize * 0.5 / pixels;
	vBrightness = brightness * level;
	// An elongated, irregular patch along the drift, within the same radius; round where the splat floor sets the size.
	float own = footprint / max(radiusKm, 1e-6);
	vLobes = patchLobes(seed, own);
	vPatch = cloudPatch(seed, ground, own, vLobes);
}
`;

export const lightMapFragmentShader = /* glsl */ `
varying vec2 vScale;
varying float vBrightness;
varying vec4 vPatch;
varying vec4 vLobes;

${patchEdgeGlsl}
void main() {
	// East and north in splat radii (gl_PointCoord runs south), then along and across the patch.
	vec2 corner = (gl_PointCoord * 2.0 - 1.0) * vec2(1.0, -1.0) * vScale;
	vec2 p = vec2(dot(corner, vPatch.xy), dot(corner, vec2(-vPatch.y, vPatch.x)) * vPatch.z);
	float r2 = dot(p, p);
	if (r2 > 0.0) {
		float edge = patchEdge(atan(p.y, p.x), vLobes) * vPatch.w;
		r2 /= edge * edge;
	}
	if (r2 > 1.0) discard;
	gl_FragColor = vec4(vec3(vBrightness * exp(-r2 * 4.0) * (1.0 - r2)), 1.0);
}
`;

/** Reads the light map at an Earth UV, sharpened near the floor, zero outside its window, fading over the window's last tenth. */
export const flashLightGlsl = /* glsl */ `
uniform sampler2D flashLight;
uniform vec4 flashWindow;
// Sharper near the floor; the globe overview keeps its broad glow.
float sharpenFlashLight(float light) {
	return pow(light, mix(${f(CLOUD_LIGHT.sharpen)}, 1.0, clamp(flashWindow.w / 1.57079633, 0.0, 1.0)));
}
float flashLightAt(vec2 uv) {
	vec2 angle = vec2((uv.x - 0.5) * 6.28318531, (uv.y - 0.5) * 3.14159265);
	vec2 local = vec2(mod(angle.x - flashWindow.x + 3.14159265, 6.28318531) - 3.14159265, angle.y - flashWindow.y) / flashWindow.zw;
	vec2 edge = 1.0 - smoothstep(0.9, 1.0, abs(local));
	return sharpenFlashLight(texture2D(flashLight, local * 0.5 + 0.5).r) * edge.x * edge.y;
}
// The same, without implicit gradients, for use inside loops.
float flashLightAtLod(vec2 uv) {
	vec2 angle = vec2((uv.x - 0.5) * 6.28318531, (uv.y - 0.5) * 3.14159265);
	vec2 local = vec2(mod(angle.x - flashWindow.x + 3.14159265, 6.28318531) - 3.14159265, angle.y - flashWindow.y) / flashWindow.zw;
	vec2 edge = 1.0 - smoothstep(0.9, 1.0, abs(local));
	return sharpenFlashLight(textureLod(flashLight, local * 0.5 + 0.5, 0.0).r) * edge.x * edge.y;
}
`;
