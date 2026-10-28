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

/**
 * Cloud opacity for any material: give it `Clouds.opacity.uniforms` and `.defines`, include this
 * chunk, then call `cloudOpacityAt(direction)` with a direction in the Earth's frame.
 */
export const cloudOpacityGlsl = /* glsl */ `
uniform sampler2D cloudMap;
uniform sampler2D cloudMapNext;
uniform float cloudMix;
uniform vec2 cloudMapSize;
uniform float cloudMaxOpacity;
uniform vec2 cloudFadeLatitudes;
uniform float cloudShown;

// Cubic B-spline from four bilinear taps: rounds texel blocks off when zoomed in.
float sampleOpacity(sampler2D map, vec2 uv, vec2 gx, vec2 gy) {
#ifdef BICUBIC
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
	float a = textureGrad(map, vec2(h0.x, h0.y), gx, gy).r;
	float b = textureGrad(map, vec2(h1.x, h0.y), gx, gy).r;
	float c = textureGrad(map, vec2(h0.x, h1.y), gx, gy).r;
	float d = textureGrad(map, vec2(h1.x, h1.y), gx, gy).r;
	return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
#else
	return textureGrad(map, uv, gx, gy).r;
#endif
}

#ifdef DETAIL
uniform sampler2DArray detailTiles;
uniform sampler2D detailPagesA;
uniform sampler2D detailPagesB;
uniform vec2 detailGrid;
uniform vec2 detailCells;
uniform float detailOn;

// Same B-spline inside one tile of the array; the tile's border holds its neighbours' texels.
float tileOpacity(vec2 geo, float z, float slot) {
	vec2 count = vec2(exp2(z + 1.0), exp2(z));
	float size = detailGrid.x + 2.0 * detailGrid.y;
	vec2 st = fract(geo * count) * detailGrid.x + detailGrid.y - 0.5;
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
	vec2 h0 = (i - 0.5 + w1 / g0) / size;
	vec2 h1 = (i + 1.5 + w3 / g1) / size;
	float a = textureLod(detailTiles, vec3(h0.x, h0.y, slot), 0.0).r;
	float b = textureLod(detailTiles, vec3(h1.x, h0.y, slot), 0.0).r;
	float c = textureLod(detailTiles, vec3(h0.x, h1.y, slot), 0.0).r;
	float d = textureLod(detailTiles, vec3(h1.x, h1.y, slot), 0.0).r;
	return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}

// The finest loaded tile over this cell, faded in over the one below it, else the global frame.
float frameOpacity(sampler2D pages, sampler2D map, vec2 uv, vec2 geo, vec2 gx, vec2 gy) {
	ivec2 cell = ivec2(min(floor(geo * detailCells), detailCells - 1.0));
	vec4 top = texelFetch(pages, ivec2(cell.x * 2, cell.y), 0) * 255.0;
	if (top.g < 0.5) return sampleOpacity(map, uv, gx, gy);
	float value = tileOpacity(geo, top.g, top.r);
	if (top.b < 254.5) {
		vec4 under = texelFetch(pages, ivec2(cell.x * 2 + 1, cell.y), 0) * 255.0;
		float base = under.g < 0.5 ? sampleOpacity(map, uv, gx, gy) : tileOpacity(geo, under.g, under.r);
		value = mix(base, value, top.b / 255.0);
	}
	return value;
}
#endif

// Longitude from 180° W and latitude from 90° N, both 0 to 1, of a direction in the Earth's frame.
vec2 cloudGeo(vec3 n) {
	return vec2(atan(-n.z, n.x) / 6.283185307 + 0.5, 0.5 - asin(clamp(n.y, -1.0, 1.0)) / 3.141592654);
}

// Opacity of the blended frames at uv and geo, before the view's limb thickening.
float cloudOpacity(vec2 uv, vec2 geo, vec2 gx, vec2 gy) {
	float a;
	float b;
#ifdef DETAIL
	if (detailOn > 0.5) {
		a = frameOpacity(detailPagesA, cloudMap, uv, geo, gx, gy);
		b = cloudMix > 0.0 ? frameOpacity(detailPagesB, cloudMapNext, uv, geo, gx, gy) : a;
	} else
#endif
	{
		a = sampleOpacity(cloudMap, uv, gx, gy);
		b = sampleOpacity(cloudMapNext, uv, gx, gy);
	}
	float sinLat = abs(sin((0.5 - geo.y) * 3.141592654));
	float fade = 1.0 - smoothstep(cloudFadeLatitudes.x, cloudFadeLatitudes.y, sinLat);
	return mix(a, b, cloudMix) * cloudMaxOpacity * fade * cloudShown;
}

// Opacity the cloud shell shows above a direction (Earth's frame), at the frames' finest level.
float cloudOpacityAt(vec3 direction) {
	vec3 n = normalize(direction);
	vec2 geo = cloudGeo(n);
	return cloudOpacity(vec2(geo.x, 1.0 - geo.y), geo, vec2(0.0), vec2(0.0));
}
`;

export const cloudsFragmentShader = /* glsl */ `
uniform vec4 twilightEdges;
uniform vec4 twilightWeights;
uniform float twilightSoftness;
uniform float sunDip;
uniform vec3 dayColor;
uniform vec3 twilightColor;
uniform vec3 nightColor;
uniform vec3 warmTint;
uniform float terminatorTint;
uniform float limbThickening;
uniform sampler2D flashLight;
uniform vec3 flashColor;
uniform float flashGain;

varying vec2 vUv;
varying vec3 vLocalNormal;
varying vec3 vNormal;
varying vec3 vSun;
varying vec3 vWorldPosition;

${cloudOpacityGlsl}

// Mirrors twilight() in the Earth shader.
float twilight(float sinElevation) {
	vec4 steps = smoothstep(twilightEdges - twilightSoftness, twilightEdges + twilightSoftness, vec4(sinElevation));
	return dot(steps, twilightWeights);
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

	// Derivatives taken here, in uniform control flow, serve every tap; the geographic position
	// comes from the normal, exact on the faceted shell, unlike the vertex UVs.
	float opacity = cloudOpacity(vUv, cloudGeo(normalize(vLocalNormal)), dFdx(vUv), dFdy(vUv));
	float mu = max(dot(n, view), 0.05);
	float alpha = 1.0 - pow(1.0 - opacity, 1.0 / mix(1.0, mu, limbThickening));

	gl_FragColor = vec4(color, alpha);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
