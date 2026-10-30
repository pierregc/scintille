export const atmosphereVertexShader = /* glsl */ `
uniform vec3 sunDirection;

varying vec3 vWorldPosition;
varying vec3 vCenter;
varying vec3 vSun;

void main() {
	vec4 world = modelMatrix * vec4(position, 1.0);
	vWorldPosition = world.xyz;
	vCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
	vSun = mat3(modelMatrix) * sunDirection;
	gl_Position = projectionMatrix * viewMatrix * world;
}
`;

// Single scattering through a spherical shell (Rayleigh, Mie, ozone absorption), in units of the planet radius.
export const atmosphereFragmentShader = /* glsl */ `
#define PRIMARY_STEPS 16
#define LIGHT_STEPS 6
// Partial view extinction stands in for multiple scattering, which keeps the day limb white instead of orange.
#define VIEW_EXTINCTION 0.35
#define PI 3.14159265

uniform float planetRadius;
uniform float atmosphereRadius;
uniform float rayleighHeight;
uniform float mieHeight;
uniform vec3 rayleighScattering;
uniform float mieScattering;
uniform float mieAnisotropy;
uniform vec3 ozoneAbsorption;
uniform float ozoneCenter;
uniform float ozoneWidth;
uniform float sunIntensity;
#ifdef CLOUD_HAZE
uniform sampler2D cloudResolved;
uniform sampler2D cloudDepth;
uniform vec2 cloudMarchSize;
uniform vec2 cloudFreshSize;
uniform vec2 cloudPhase;
uniform float cloudFade;
uniform vec2 cloudViewport;
#endif

varying vec3 vWorldPosition;
varying vec3 vCenter;
varying vec3 vSun;

vec2 raySphere(vec3 origin, vec3 dir, float radius) {
	float b = dot(origin, dir);
	float c = dot(origin, origin) - radius * radius;
	float d = b * b - c;
	if (d < 0.0) return vec2(1e9, -1e9);
	d = sqrt(d);
	return vec2(-b - d, -b + d);
}

vec3 densities(vec3 p) {
	float h = max(length(p) - planetRadius, 0.0);
	float ozone = max(0.0, 1.0 - abs(h - ozoneCenter) / ozoneWidth);
	return vec3(exp(-h / rayleighHeight), exp(-h / mieHeight), ozone);
}

vec3 extinction(vec3 depth) {
	return rayleighScattering * depth.x + mieScattering * 1.1 * depth.y + ozoneAbsorption * depth.z;
}

vec3 sunDepth(vec3 p, vec3 sun) {
	float len = raySphere(p, sun, atmosphereRadius).y;
	float step = len / float(LIGHT_STEPS);
	vec3 depth = vec3(0.0);
	for (int i = 0; i < LIGHT_STEPS; i++) {
		depth += densities(p + sun * (float(i) + 0.5) * step) * step;
	}
	return depth;
}

void main() {
	vec3 origin = cameraPosition - vCenter;
	vec3 dir = normalize(vWorldPosition - cameraPosition);
	vec3 sun = normalize(vSun);

	vec2 shell = raySphere(origin, dir, atmosphereRadius);
	vec2 ground = raySphere(origin, dir, planetRadius);
	float start = max(shell.x, 0.0);
	float end = ground.x > 0.0 ? min(shell.y, ground.x) : shell.y;
	if (end <= start) discard;

	float step = (end - start) / float(PRIMARY_STEPS);
	vec3 viewDepth = vec3(0.0);
	vec3 rayleigh = vec3(0.0);
	vec3 mie = vec3(0.0);
	for (int i = 0; i < PRIMARY_STEPS; i++) {
		vec3 p = origin + dir * (start + (float(i) + 0.5) * step);
		vec3 density = densities(p) * step;
		viewDepth += density;
		vec3 light = exp(-extinction(viewDepth * VIEW_EXTINCTION + sunDepth(p, sun)));
		rayleigh += light * density.x;
		mie += light * density.y;
	}

	float mu = dot(dir, sun);
	float g = mieAnisotropy;
	float rayleighPhase = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
	float miePhase = 3.0 / (8.0 * PI) * (1.0 - g * g) * (1.0 + mu * mu)
		/ ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));

	vec3 radiance = sunIntensity * (rayleigh * rayleighScattering * rayleighPhase + mie * mieScattering * miePhase);
	vec3 transmittance = exp(-extinction(viewDepth));

	// Written as display values: blending sRGB-encoded light would wash out the disc.
	vec3 haze = 1.0 - exp(-radiance);
	float through = dot(transmittance, vec3(1.0 / 3.0));
#ifdef CLOUD_HAZE
	// Over the clouds the volume draws, only the air above their tops hazes and dims them: about
	// exp(-height / 8 km) of the column, so high tops stay white.
	vec2 screen = gl_FragCoord.xy / cloudViewport;
	float cover = (1.0 - texture2D(cloudResolved, screen).a) * cloudFade;
	vec2 q = ((screen * cloudMarchSize - cloudPhase - 0.5) / 2.0 + 0.5) / cloudFreshSize;
	float above = exp(-texture2D(cloudDepth, q).b / 8.0);
	// Toward the limb the line of sight runs long through the air above the clouds: keep its haze.
	float steep = ground.x > 0.0 ? smoothstep(0.15, 0.4, -dot(dir, normalize(origin + dir * ground.x))) : 0.0;
	cover *= steep;
	haze *= 1.0 - cover * (1.0 - above);
	through = mix(through, pow(through, above), cover);
#endif
	gl_FragColor = vec4(haze, through);
}
`;
