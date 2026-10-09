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
uniform float terminatorTint;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vSun;
varying vec3 vWorldPosition;

// Mirrors twilightLevel() in twilight.ts.
float twilight(float sinElevation) {
	vec4 steps = smoothstep(twilightEdges - twilightSoftness, twilightEdges + twilightSoftness, vec4(sinElevation));
	return dot(steps, twilightWeights);
}

void main() {
	vec3 n = normalize(vNormal);
	vec3 sun = normalize(vSun);
	float s = dot(n, sun);
	float level = twilight(s);

	vec3 day = texture2D(dayMap, vUv).rgb;
	vec3 night = texture2D(nightMap, vUv).rgb;
	float water = texture2D(oceanMask, vUv).r;

	float direct = sqrt(max(s, 0.0));
	vec3 color = day * mix(twilightFloor * level, 1.0, direct);

	float edge = exp(-s * s / 0.006);
	color *= mix(vec3(1.0), vec3(1.6, 0.9, 0.5), terminatorTint * edge);

	color += night * nightLights * (1.0 - level);

	vec3 view = normalize(cameraPosition - vWorldPosition);
	float glint = pow(max(dot(n, normalize(sun + view)), 0.0), 60.0);
	color += vec3(1.0, 0.95, 0.85) * specular * water * glint * smoothstep(0.0, 0.2, s);

	gl_FragColor = vec4(color, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
