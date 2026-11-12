import { MIDDLE_GREY, rec2020Luminance } from '../colour/spaces';
import type { Gpu } from '../gpu/gpu';
import { glslFloat } from '../gpu/glsl';
import type { Image, Size, Texture } from '../gpu/image';
import { run } from '../gpu/pass';
import { float, vec2 } from '../gpu/uniforms';
import { glslVector } from '../math/matrix';

/**
 * The restored scene and the fields derived from it. This is everything an
 * adjustment may read besides its own parameters: tonal zones and masks are
 * defined on it, so no adjustment can move another's target.
 */
export interface Reference {
	readonly scene: Image<'scene'>;
	/** Luminance in stops relative to middle grey. */
	readonly stops: Image<'stops'>;
	/** `stops` with detail removed and edges kept: the tonal zone a pixel belongs to. */
	readonly smoothedStops: Image<'stops'>;
}

/** GLSL view of the reference at one pixel, for shaders that bind its three textures. */
export const referenceGlsl = /* glsl */ `
struct Reference {
	vec3 scene;
	float stops;
	float smoothed_stops;
};

Reference reference_at(ivec2 p) {
	return Reference(
		texelFetch(scene, p, 0).rgb,
		texelFetch(stops, p, 0).r,
		texelFetch(smoothed_stops, p, 0).r
	);
}`;

export const referenceTextures = (reference: Reference) => ({
	scene: reference.scene,
	stops: reference.stops,
	smoothed_stops: reference.smoothedStops
});

// Black has no finite distance from middle grey in stops; the field bottoms out here.
const DARKEST_STOPS = -16;

const stopsGlsl = /* glsl */ `
vec4 pixel(ivec2 p) {
	float luminance = dot(texelFetch(scene, p, 0).rgb, ${glslVector(rec2020Luminance)});
	return vec4(log2(max(luminance, ${glslFloat(MIDDLE_GREY * 2 ** DARKEST_STOPS)}) / ${glslFloat(MIDDLE_GREY)}), 0, 0, 1);
}`;

// Smoothing is a guided filter with the image as its own guide (He, Sun & Tang,
// "Guided Image Filtering", 2013), with the coefficients computed on a reduced
// image and interpolated (He & Sun, "Fast Guided Filter", 2015). The window is a
// fraction of the image so the result does not depend on resolution.
const REDUCED_LONG_SIDE = 512;

export interface Smoothing {
	/** Window radius as a fraction of the image's long side. */
	readonly radius: number;
	/** Stops squared: variation within a window above this counts as an edge and is kept. */
	readonly edgeVariance: number;
}

/** Wide enough that a region of one tone reads as one zone. */
const ZONES: Smoothing = { radius: 0.025, edgeVariance: 0.25 };

/** Block means of the value and its square, in r and g. */
const reduceGlsl = /* glsl */ `
vec4 pixel(ivec2 p) {
	int factor = int(u.factor);
	ivec2 limit = textureSize(stops, 0) - 1;
	vec2 sum = vec2(0);
	for (int y = 0; y < factor; y++) {
		for (int x = 0; x < factor; x++) {
			float v = texelFetch(stops, min(p * factor + ivec2(x, y), limit), 0).r;
			sum += vec2(v, v * v);
		}
	}
	return vec4(sum / float(factor * factor), 0, 1);
}`;

const boxGlsl = /* glsl */ `
vec4 pixel(ivec2 p) {
	int radius = int(u.radius);
	ivec2 limit = textureSize(image, 0) - 1;
	vec4 sum = vec4(0);
	for (int i = -radius; i <= radius; i++) {
		sum += texelFetch(image, clamp(p + i * ivec2(u.axis), ivec2(0), limit), 0);
	}
	return sum / float(2 * radius + 1);
}`;

/** Per window, the line `smoothed = a * value + b` that best fits it; a and b in r and g. */
const coefficientsGlsl = /* glsl */ `
vec4 pixel(ivec2 p) {
	vec4 moments = texelFetch(means, p, 0);
	float variance = moments.g - moments.r * moments.r;
	float a = variance / (variance + u.edge_variance);
	return vec4(a, (1.0 - a) * moments.r, 0, 1);
}`;

const applyGlsl = /* glsl */ `
vec4 pixel(ivec2 p) {
	ivec2 limit = textureSize(coefficients, 0) - 1;
	vec2 position = (vec2(p) + 0.5) / u.factor - 0.5;
	ivec2 corner = ivec2(floor(position));
	vec2 t = position - floor(position);
	vec4 c00 = texelFetch(coefficients, clamp(corner, ivec2(0), limit), 0);
	vec4 c10 = texelFetch(coefficients, clamp(corner + ivec2(1, 0), ivec2(0), limit), 0);
	vec4 c01 = texelFetch(coefficients, clamp(corner + ivec2(0, 1), ivec2(0), limit), 0);
	vec4 c11 = texelFetch(coefficients, clamp(corner + ivec2(1, 1), ivec2(0), limit), 0);
	vec4 c = mix(mix(c00, c10, t.x), mix(c01, c11, t.x), t.y);
	return vec4(c.r * texelFetch(stops, p, 0).r + c.g, 0, 0, 1);
}`;

function box(gpu: Gpu, image: Texture, radius: number): Texture {
	const blur = (source: Texture, axis: readonly [number, number]) =>
		run(gpu, {
			label: 'box',
			glsl: boxGlsl,
			textures: { image: source },
			uniforms: { radius: float(radius), axis: vec2(axis) },
			size: source,
			format: 'RGBA32F'
		});
	const horizontal = blur(image, [1, 0]);
	const both = blur(horizontal, [0, 1]);
	horizontal.destroy();
	return both;
}

/** `stops` with variation finer than the window removed, except across edges. */
export function smooth(gpu: Gpu, stops: Image<'stops'>, smoothing: Smoothing): Image<'stops'> {
	const longSide = Math.max(stops.width, stops.height);
	const factor = Math.ceil(longSide / REDUCED_LONG_SIDE);
	const reducedSize: Size = {
		width: Math.ceil(stops.width / factor),
		height: Math.ceil(stops.height / factor)
	};
	const radius = Math.round((smoothing.radius * longSide) / factor);

	const reduced = run(gpu, {
		label: 'reduce',
		glsl: reduceGlsl,
		textures: { stops },
		uniforms: { factor: float(factor) },
		size: reducedSize,
		format: 'RGBA32F'
	});
	const means = box(gpu, reduced, radius);
	const perWindow = run(gpu, {
		label: 'coefficients',
		glsl: coefficientsGlsl,
		textures: { means },
		uniforms: { edge_variance: float(smoothing.edgeVariance) },
		size: reducedSize,
		format: 'RGBA32F'
	});
	const coefficients = box(gpu, perWindow, radius);
	const smoothed = run<'stops'>(gpu, {
		label: 'smoothed stops',
		glsl: applyGlsl,
		textures: { stops, coefficients },
		uniforms: { factor: float(factor) },
		size: stops,
		format: 'R32F'
	});
	for (const texture of [reduced, means, perWindow, coefficients]) texture.destroy();
	return smoothed;
}

/** Luminance of a scene image in stops relative to middle grey. */
export const stopsOf = (gpu: Gpu, scene: Image<'scene'>): Image<'stops'> =>
	run(gpu, {
		label: 'stops',
		glsl: stopsGlsl,
		textures: { scene },
		uniforms: {},
		size: scene,
		format: 'R32F'
	});

/** Takes ownership of `scene`. */
export function measure(gpu: Gpu, scene: Image<'scene'>): Reference {
	const stops = stopsOf(gpu, scene);
	return { scene, stops, smoothedStops: smooth(gpu, stops, ZONES) };
}

export function destroyReference(reference: Reference): void {
	reference.scene.destroy();
	reference.stops.destroy();
	reference.smoothedStops.destroy();
}
