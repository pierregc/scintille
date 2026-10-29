export const earthVertexShader = /* glsl */ `
uniform vec3 sunDirection;

varying vec3 vGeo;
varying vec3 vNormal;
varying vec3 vSun;
varying vec3 vWorldPosition;

void main() {
	mat3 model = mat3(modelMatrix);
	vec4 world = modelMatrix * vec4(position, 1.0);
	vGeo = position;
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
#ifdef SURFACE
uniform highp sampler2DArray surfaceTiles;
uniform sampler2D surfacePages;
// Finest level columns and rows, tile texels, border texels.
uniform vec4 surfaceGrid;
uniform float surfaceFinest;
uniform float surfaceOn;
uniform float surfaceDayGain;
uniform vec3 surfaceNightGain[6];

// Coordinates of uv in the level z tile over this cell, and their scale from uv.
vec2 tileCoord(vec2 uv, vec2 cell, float z, out vec2 scale) {
	float cells = exp2(surfaceFinest - z);
	vec2 count = surfaceGrid.xy / cells;
	float span = surfaceGrid.z + 2.0 * surfaceGrid.w;
	scale = count * surfaceGrid.z / span;
	return (uv * count - floor(cell / cells)) * (surfaceGrid.z / span) + surfaceGrid.w / span;
}

vec4 dayTile(vec2 uv, vec2 cell, vec2 page, vec2 gx, vec2 gy) {
	vec2 scale;
	vec2 st = tileCoord(uv, cell, page.y, scale);
	vec4 texel = textureGrad(surfaceTiles, vec3(st, page.x), gx * scale, gy * scale);
	return vec4(texel.rgb * surfaceDayGain, texel.a);
}

// Cubic B-spline in four bilinear taps: night lights are 742 m sensor pixels, shown as soft points.
vec3 nightTile(vec2 uv, vec2 cell, vec2 page, vec2 gx, vec2 gy) {
	vec2 scale;
	vec2 st = tileCoord(uv, cell, page.y, scale);
	float size = surfaceGrid.z + 2.0 * surfaceGrid.w;
	vec2 dx = gx * scale;
	vec2 dy = gy * scale;
	vec2 p = st * size - 0.5;
	vec2 i = floor(p);
	vec2 f = p - i;
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
	vec3 a = textureGrad(surfaceTiles, vec3(h0.x, h0.y, page.x), dx, dy).rgb;
	vec3 b = textureGrad(surfaceTiles, vec3(h1.x, h0.y, page.x), dx, dy).rgb;
	vec3 c = textureGrad(surfaceTiles, vec3(h0.x, h1.y, page.x), dx, dy).rgb;
	vec3 d = textureGrad(surfaceTiles, vec3(h1.x, h1.y, page.x), dx, dy).rgb;
	return (g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d)) * surfaceNightGain[int(page.y)];
}

// Page texel: shown layer, faded layer, shown level + 16 × faded level, fade. Level 0 is the global texture.
vec4 pageAt(vec2 cell, float layer) {
	return floor(texelFetch(surfacePages, ivec2(int(cell.x) * 2 + int(layer), int(cell.y)), 0) * 255.0 + 0.5);
}
#endif

varying vec3 vGeo;
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

	// Longitude from 180° W and latitude from 90° S, 0 to 1, of the point itself rather than the mesh's
	// interpolated UVs, which bend near the poles; the longitude derivative wraps at the antimeridian.
	vec3 geo = normalize(vGeo);
	vec2 uv = vec2(atan(-geo.z, geo.x) / 6.283185307 + 0.5, asin(clamp(geo.y, -1.0, 1.0)) / 3.141592654 + 0.5);
	vec2 gx = dFdx(uv);
	vec2 gy = dFdy(uv);
	gx.x -= floor(gx.x + 0.5);
	gy.x -= floor(gy.x + 0.5);
	vec3 day = textureGrad(dayMap, uv, gx, gy).rgb;
	vec3 night = textureGrad(nightMap, uv, gx, gy).rgb;
	float water = textureGrad(oceanMask, uv, gx, gy).r;
	#ifdef SURFACE
	if (surfaceOn > 0.5) {
		vec2 cell = min(floor(uv * surfaceGrid.xy), surfaceGrid.xy - 1.0);
		vec4 page = pageAt(cell, 0.0);
		float z = mod(page.b, 16.0);
		float under = floor(page.b / 16.0);
		if (z + under > 0.5) {
			vec4 base = vec4(day, water);
			vec4 shown = z > 0.5 ? dayTile(uv, cell, vec2(page.r, z), gx, gy) : base;
			if (page.a < 254.5) shown = mix(under > 0.5 ? dayTile(uv, cell, vec2(page.g, under), gx, gy) : base, shown, page.a / 255.0);
			day = shown.rgb;
			water = shown.a;
		}
		page = pageAt(cell, 1.0);
		z = mod(page.b, 16.0);
		under = floor(page.b / 16.0);
		if (z + under > 0.5) {
			vec3 shown = z > 0.5 ? nightTile(uv, cell, vec2(page.r, z), gx, gy) : night;
			if (page.a < 254.5) shown = mix(under > 0.5 ? nightTile(uv, cell, vec2(page.g, under), gx, gy) : night, shown, page.a / 255.0);
			night = shown;
		}
	}
	#endif

	float direct = sqrt(max(s, 0.0)) * smoothstep(-0.02, 0.15, s);
	vec3 color = day * mix(twilightFloor * level, 1.0, direct);

	float edge = exp(-s * s / 0.006);
	color *= mix(vec3(1.0), vec3(1.6, 0.9, 0.5), terminatorTint * edge);

	color += night * nightLights * (1.0 - level);

	vec3 view = normalize(cameraPosition - vWorldPosition);
	color += vec3(0.92, 0.95, 1.0) * specular * water * glint(n, sun, view) * smoothstep(0.0, 0.2, s);

	// No lightning data here: desaturated, dimmed and finely hatched, visible by day and by night.
	float gap = textureGrad(coverageMap, uv, gx, gy).r * coverageShade;
	float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
	color = mix(color, vec3(luma) * 0.55, 0.8 * gap);
	float hatch = smoothstep(2.3, 3.5, abs(mod(gl_FragCoord.x + gl_FragCoord.y, 7.0) - 3.5));
	color += vec3(0.58, 0.64, 0.74) * 0.07 * hatch * gap;

	gl_FragColor = vec4(color, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
