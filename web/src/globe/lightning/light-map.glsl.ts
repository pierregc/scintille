import { intensityGlsl } from './intensity';
import { playbackGlsl } from './playback';
import { flashProfileGlsl } from './profile';

/** Splats each flash as a soft point sprite over an equirectangular window of the globe, in SphereGeometry UV angles. */
export const lightMapVertexShader = /* glsl */ `
attribute vec4 flash;
attribute vec3 flashShape;

uniform float time;
uniform float duration;
uniform float flicker;
uniform vec4 window;
uniform float splat;
uniform float spreadKm;
uniform float minSplatKm;
uniform float wrap;
uniform vec2 mapSize;

varying vec2 vScale;
varying float vBrightness;

${playbackGlsl}
${flashProfileGlsl}
${intensityGlsl}
void main() {
	float sceneAge = time - flash.w;
	if (sceneAge < 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}
	vec3 d = normalize(flash.xyz);
	float lat = asin(clamp(d.y, -1.0, 1.0));
	float lon = atan(-d.z, d.x);
	float relative = mod(lon - window.x + 3.14159265, 6.28318531) - 3.14159265;
	// Flashes near the antimeridian of the window are drawn a second time on the other side.
	relative += wrap * (relative > 0.0 ? -6.28318531 : 6.28318531);
	vec2 center = vec2(relative, lat - window.y) / window.zw;
	float brightness = 0.0;
	if (abs(center.x) < 1.2 && abs(center.y) < 1.2) {
		float seed = fract(sin(dot(flash.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
		brightness = flashProfile(wallAge(time, flash.w), sceneAge, duration, flashShape.z, seed, flicker) * intensityBrightness(flashShape.x);
	}
	if (brightness <= 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}
	float radius = max(max(flashShape.y * splat, spreadKm), minSplatKm) / 6371.0;
	vec2 pixels = vec2(radius / max(cos(lat), 0.05), radius) / window.zw * mapSize * 0.5;
	gl_PointSize = 2.0 * max(pixels.x, pixels.y);
	gl_Position = vec4(center, 0.0, 1.0);
	vScale = gl_PointSize * 0.5 / pixels;
	vBrightness = brightness;
}
`;

export const lightMapFragmentShader = /* glsl */ `
varying vec2 vScale;
varying float vBrightness;

void main() {
	vec2 corner = (gl_PointCoord * 2.0 - 1.0) * vScale;
	float r2 = dot(corner, corner);
	if (r2 > 1.0) discard;
	gl_FragColor = vec4(vec3(vBrightness * exp(-r2 * 4.0) * (1.0 - r2)), 1.0);
}
`;

/** Reads the light map at an Earth UV, zero outside its window, fading over the window's last tenth. */
export const flashLightGlsl = /* glsl */ `
uniform sampler2D flashLight;
uniform vec4 flashWindow;
float flashLightAt(vec2 uv) {
	vec2 angle = vec2((uv.x - 0.5) * 6.28318531, (uv.y - 0.5) * 3.14159265);
	vec2 local = vec2(mod(angle.x - flashWindow.x + 3.14159265, 6.28318531) - 3.14159265, angle.y - flashWindow.y) / flashWindow.zw;
	vec2 edge = 1.0 - smoothstep(0.9, 1.0, abs(local));
	return texture2D(flashLight, local * 0.5 + 0.5).r * edge.x * edge.y;
}
`;
