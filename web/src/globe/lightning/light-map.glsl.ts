import { flashProfileGlsl } from './profile';

/** Splats each flash as a soft point sprite in equirectangular UV space, matching SphereGeometry UVs. */
export const lightMapVertexShader = /* glsl */ `
attribute vec4 flash;
attribute vec3 flashShape;

uniform float time;
uniform float duration;
uniform float flicker;
uniform float intensityFloor;
uniform float spreadKm;
uniform float wrap;
uniform vec2 mapSize;

varying vec2 vScale;
varying float vBrightness;

${flashProfileGlsl}
void main() {
	float age = time - flash.w;
	if (age < 0.0 || age > duration) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}
	vec3 d = normalize(flash.xyz);
	float lat = asin(clamp(d.y, -1.0, 1.0));
	float lon = atan(-d.z, d.x);
	vec2 center = vec2(lon / 3.14159265, lat / 1.5707963);
	// Flashes near the dateline are drawn a second time on the other side.
	center.x += wrap * (center.x > 0.0 ? -2.0 : 2.0);
	float brightness = 0.0;
	if (abs(center.x) < 1.2) {
		float seed = fract(sin(dot(flash.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
		brightness = flashProfile(age, duration, flashShape.z, seed, flicker) * mix(intensityFloor, 1.0, flashShape.x);
	}
	if (brightness <= 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}
	float radius = max(flashShape.y * 3.0, spreadKm) / 6371.0;
	vec2 pixels = vec2(radius / (3.14159265 * max(cos(lat), 0.05)), radius / 1.5707963) * mapSize * 0.5;
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
