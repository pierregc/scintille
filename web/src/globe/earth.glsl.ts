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
uniform vec4 uvRect;
#ifdef TILE
uniform sampler2D tileDay;
uniform sampler2D tileNight;
uniform vec2 tileLayers;
uniform vec2 tileInset;
uniform float tileSize;
uniform vec3 nightRect;

// Cubic B-spline in four bilinear taps: night lights are 742 m sensor pixels, shown as soft points.
vec3 bicubic(sampler2D map, vec2 uv) {
	vec2 gx = dFdx(uv);
	vec2 gy = dFdy(uv);
	vec2 st = uv * tileSize - 0.5;
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
	vec2 h0 = (i - 0.5 + w1 / g0) / tileSize;
	vec2 h1 = (i + 1.5 + w3 / g1) / tileSize;
	vec3 a = textureGrad(map, vec2(h0.x, h0.y), gx, gy).rgb;
	vec3 b = textureGrad(map, vec2(h1.x, h0.y), gx, gy).rgb;
	vec3 c = textureGrad(map, vec2(h0.x, h1.y), gx, gy).rgb;
	vec3 d = textureGrad(map, vec2(h1.x, h1.y), gx, gy).rgb;
	return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}
#endif

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

	vec2 uv = uvRect.xy + vUv * uvRect.zw;
	vec3 day = texture2D(dayMap, uv).rgb;
	vec3 night = texture2D(nightMap, uv).rgb;
	float water = texture2D(oceanMask, uv).r;
	#ifdef TILE
	vec2 tileUv = vUv * tileInset.x + tileInset.y;
	if (tileLayers.x > 0.5) {
		vec4 texel = texture2D(tileDay, tileUv);
		day = texel.rgb;
		water = texel.a;
	}
	if (tileLayers.y > 0.5) night = bicubic(tileNight, (vUv * nightRect.z + nightRect.xy) * tileInset.x + tileInset.y);
	#endif

	float direct = sqrt(max(s, 0.0)) * smoothstep(-0.02, 0.15, s);
	vec3 color = day * mix(twilightFloor * level, 1.0, direct);

	float edge = exp(-s * s / 0.006);
	color *= mix(vec3(1.0), vec3(1.6, 0.9, 0.5), terminatorTint * edge);

	color += night * nightLights * (1.0 - level);

	vec3 view = normalize(cameraPosition - vWorldPosition);
	color += vec3(0.92, 0.95, 1.0) * specular * water * glint(n, sun, view) * smoothstep(0.0, 0.2, s);

	// No lightning data here: desaturated, dimmed and finely hatched, visible by day and by night.
	float gap = texture2D(coverageMap, uv).r * coverageShade;
	float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
	color = mix(color, vec3(luma) * 0.55, 0.8 * gap);
	float hatch = smoothstep(2.3, 3.5, abs(mod(gl_FragCoord.x + gl_FragCoord.y, 7.0) - 3.5));
	color += vec3(0.58, 0.64, 0.74) * 0.07 * hatch * gap;

	gl_FragColor = vec4(color, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
