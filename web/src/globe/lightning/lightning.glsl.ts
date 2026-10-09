export const lightningVertexShader = /* glsl */ `
attribute vec4 flash;
attribute vec2 flashShape;

uniform float time;
uniform float duration;
uniform float radius;
uniform float lift;
uniform float kmToWorld;
uniform float glowScale;
uniform float minPixels;
uniform float viewportHeight;
uniform float intensityFloor;

varying vec2 vCorner;
varying float vBrightness;

// Fast rise, then a decay that reaches zero at the end of the display duration.
float envelope(float age) {
	if (age < 0.0 || age > duration) return 0.0;
	float t = age / duration;
	return smoothstep(0.0, 0.03, t) * exp(-t * 5.0) * (1.0 - t);
}

void main() {
	vec3 normal = normalize(mat3(modelMatrix) * flash.xyz);
	vec3 center = (modelMatrix * vec4(flash.xyz * radius * (1.0 + lift), 1.0)).xyz;
	float facing = dot(normal, normalize(cameraPosition - center));
	float brightness = envelope(time - flash.w) * mix(intensityFloor, 1.0, flashShape.x) * smoothstep(0.0, 0.1, facing);
	if (brightness <= 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}

	vec3 east = abs(normal.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), normal));
	vec3 north = cross(normal, east);
	float distance = length(cameraPosition - center);
	float pixel = 2.0 * distance / (projectionMatrix[1][1] * viewportHeight);
	float size = max(flashShape.y * kmToWorld * glowScale, minPixels * pixel);

	vec3 world = center + (east * position.x + north * position.y) * size;
	gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
	vCorner = position.xy;
	vBrightness = brightness;
}
`;

export const lightningFragmentShader = /* glsl */ `
uniform vec3 color;
uniform float exposure;

varying vec2 vCorner;
varying float vBrightness;

void main() {
	float r2 = dot(vCorner, vCorner);
	if (r2 > 1.0) discard;
	float glow = exp(-r2 * 12.0) + 0.25 * exp(-r2 * 3.0);
	glow *= 1.0 - r2;
	gl_FragColor = vec4(color * exposure * vBrightness * glow, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
