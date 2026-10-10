export const cloudsVertexShader = /* glsl */ `
uniform vec3 sunDirection;

varying vec2 vUv;
varying vec3 vLocalNormal;
varying vec3 vNormal;
varying vec3 vSun;
varying vec3 vWorldPosition;

void main() {
	mat3 model = mat3(modelMatrix);
	vec4 world = modelMatrix * vec4(position, 1.0);
	vUv = uv;
	vLocalNormal = normal;
	vNormal = model * normal;
	vSun = model * sunDirection;
	vWorldPosition = world.xyz;
	gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const cloudsFragmentShader = /* glsl */ `
uniform sampler2D cloudMap;
uniform vec2 cloudMapSize;
uniform vec4 twilightEdges;
uniform vec4 twilightWeights;
uniform float twilightSoftness;
uniform float sunDip;
uniform vec3 dayColor;
uniform vec3 twilightColor;
uniform vec3 nightColor;
uniform vec3 warmTint;
uniform float terminatorTint;
uniform float maxOpacity;
uniform float limbThickening;
uniform vec2 fadeLatitudes;
uniform sampler2D flashLight;
uniform vec3 flashColor;
uniform float flashGain;

varying vec2 vUv;
varying vec3 vLocalNormal;
varying vec3 vNormal;
varying vec3 vSun;
varying vec3 vWorldPosition;

// Mirrors twilight() in the Earth shader.
float twilight(float sinElevation) {
	vec4 steps = smoothstep(twilightEdges - twilightSoftness, twilightEdges + twilightSoftness, vec4(sinElevation));
	return dot(steps, twilightWeights);
}

// Cubic B-spline from four bilinear taps: rounds texel blocks off when zoomed in.
float sampleOpacity(vec2 uv) {
#ifdef BICUBIC
	vec2 gx = dFdx(uv);
	vec2 gy = dFdy(uv);
	vec2 st = uv * cloudMapSize - 0.5;
	vec2 i = floor(st);
	vec2 f = st - i;
	vec2 f2 = f * f;
	vec2 f3 = f2 * f;
	vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
	vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
	vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
	vec2 w3 = f3 / 6.0;
	vec2 g0 = w0 + w1;
	vec2 g1 = w2 + w3;
	vec2 h0 = (i - 0.5 + w1 / g0) / cloudMapSize;
	vec2 h1 = (i + 1.5 + w3 / g1) / cloudMapSize;
	float a = textureGrad(cloudMap, vec2(h0.x, h0.y), gx, gy).r;
	float b = textureGrad(cloudMap, vec2(h1.x, h0.y), gx, gy).r;
	float c = textureGrad(cloudMap, vec2(h0.x, h1.y), gx, gy).r;
	float d = textureGrad(cloudMap, vec2(h1.x, h1.y), gx, gy).r;
	return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
#else
	return texture2D(cloudMap, uv).r;
#endif
}

void main() {
	vec3 n = normalize(vNormal);
	vec3 sun = normalize(vSun);
	vec3 view = normalize(cameraPosition - vWorldPosition);

	// Cloud tops still see the sun a little past the ground terminator.
	float s = dot(n, sun) + sunDip;
	float level = twilight(s);
	float direct = sqrt(max(s, 0.0)) * smoothstep(-0.02, 0.12, s);

	vec3 color = mix(twilightColor * level, dayColor, direct);
	float edge = exp(-(s - 0.03) * (s - 0.03) / 0.004);
	color *= mix(vec3(1.0), warmTint, terminatorTint * edge);
	color += nightColor * (1.0 - level);
	// Flashes light the cloud from inside; clear sky has no alpha, so it never glows.
	color += flashColor * (1.0 - exp(-flashGain * texture2D(flashLight, vUv).r));

	float opacity = sampleOpacity(vUv) * maxOpacity;
	float mu = max(dot(n, view), 0.05);
	float alpha = 1.0 - pow(1.0 - opacity, 1.0 / mix(1.0, mu, limbThickening));
	alpha *= 1.0 - smoothstep(fadeLatitudes.x, fadeLatitudes.y, abs(normalize(vLocalNormal).y));

	gl_FragColor = vec4(color, alpha);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
