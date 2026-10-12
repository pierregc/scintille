export const earthVertexShader = /* glsl */ `
uniform vec3 sunDirection;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vSun;
varying vec3 vWorldPosition;

void main() {
	mat3 model = mat3(modelMatrix);
	vec4 world = modelMatrix * vec4(position, 1.0);
	vUv = uv;
	vNormal = model * normal;
	vSun = model * sunDirection;
	vWorldPosition = world.xyz;
	gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const earthFragmentShader = /* glsl */ `
uniform sampler2D dayMap;
uniform sampler2D nightMap;
uniform sampler2D oceanMask;
uniform vec4 twilightEdges;
uniform vec4 twilightWeights;
uniform float twilightSoftness;
uniform float twilightFloor;
uniform float nightLights;
uniform float specular;
uniform float seaRoughness;
uniform float glintCap;
uniform float terminatorTint;
uniform sampler2D coverageMap;
uniform float coverageShade;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vSun;
varying vec3 vWorldPosition;

// Mirrors twilightLevel() in twilight.ts.
float twilight(float sinElevation) {
	vec4 steps = smoothstep(twilightEdges - twilightSoftness, twilightEdges + twilightSoftness, vec4(sinElevation));
	return dot(steps, twilightWeights);
}

// Sun glint on a rough sea: Beckmann slope distribution with Schlick Fresnel, elongated toward the limb.
float glint(vec3 n, vec3 sun, vec3 view) {
	vec3 h = normalize(sun + view);
	float nh = max(dot(n, h), 1e-3);
	float nh2 = nh * nh;
	float slopes = exp((nh2 - 1.0) / (nh2 * seaRoughness)) / (3.14159 * seaRoughness * nh2 * nh2);
	float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(h, view), 0.0), 5.0);
	return min(slopes * fresnel / (4.0 * max(dot(n, view), 0.1)), glintCap);
}

void main() {
	vec3 n = normalize(vNormal);
	vec3 sun = normalize(vSun);
	float s = dot(n, sun);
	float level = twilight(s);

	vec3 day = texture2D(dayMap, vUv).rgb;
	vec3 night = texture2D(nightMap, vUv).rgb;
	float water = texture2D(oceanMask, vUv).r;

	float direct = sqrt(max(s, 0.0)) * smoothstep(-0.02, 0.15, s);
	vec3 color = day * mix(twilightFloor * level, 1.0, direct);

	float edge = exp(-s * s / 0.006);
	color *= mix(vec3(1.0), vec3(1.6, 0.9, 0.5), terminatorTint * edge);

	color += night * nightLights * (1.0 - level);

	vec3 view = normalize(cameraPosition - vWorldPosition);
	color += vec3(0.92, 0.95, 1.0) * specular * water * glint(n, sun, view) * smoothstep(0.0, 0.2, s);

	// No lightning data here: desaturated, dimmed and finely hatched, visible by day and by night.
	float gap = texture2D(coverageMap, vUv).r * coverageShade;
	float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
	color = mix(color, vec3(luma) * 0.55, 0.8 * gap);
	float hatch = smoothstep(2.3, 3.5, abs(mod(gl_FragCoord.x + gl_FragCoord.y, 7.0) - 3.5));
	color += vec3(0.58, 0.64, 0.74) * 0.07 * hatch * gap;

	gl_FragColor = vec4(color, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
