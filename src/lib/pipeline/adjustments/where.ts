import { float, vec2, vec3, type Uniforms } from '../../gpu/uniforms';
import type { Size } from '../../gpu/image';
import type { Element, How, Where } from './row';

/** Shared by every generated weight function. */
export const whereGlsl = /* glsl */ `
/** 0 below \`at - softness\`, rising to 1 at \`at\`. */
float edge(float x, float at, float softness) {
	return softness > 0.0 ? smoothstep(at - softness, at, x) : step(at, x);
}

/** \`range\` is low, high, softness. */
float tone_weight(float stops, vec3 range) {
	return edge(stops, range.x, range.z) * (1.0 - edge(stops, range.y + range.z, range.z));
}

/** \`q\`, \`from\` and \`to\` in pixels. */
float gradient_weight(vec2 q, vec2 from, vec2 to) {
	vec2 along = to - from;
	return 1.0 - smoothstep(0.0, 1.0, dot(q - from, along) / dot(along, along));
}

/** \`q\`, \`centre\` and \`radii\` in pixels. */
float ellipse_weight(vec2 q, vec2 centre, vec2 radii, float angle, float feather) {
	vec2 d = q - centre;
	// Image rows run downwards, so an anticlockwise angle on screen is negative here.
	vec2 local = vec2(d.x * cos(angle) - d.y * sin(angle), d.x * sin(angle) + d.y * cos(angle));
	return 1.0 - edge(length(local / radii), 1.0 + feather, feather);
}`;

const pixels = ([x, y]: readonly [number, number], size: Size): readonly [number, number] => [
	x * size.width,
	y * size.height
];

interface Generated {
	readonly glsl: string;
	readonly uniforms: Uniforms;
}

/** `areas` names the weight function of each earlier row, by row id. */
function selected(
	prefix: string,
	element: Element,
	size: Size,
	areas: ReadonlyMap<number, string>
): Generated {
	switch (element.kind) {
		case 'tones':
			return {
				glsl: `tone_weight(reference.smoothed_stops, u.${prefix}tones)`,
				uniforms: { [`${prefix}tones`]: vec3([element.low, element.high, element.softness]) }
			};
		case 'gradient':
			return {
				glsl: `gradient_weight(q, u.${prefix}from, u.${prefix}to)`,
				uniforms: {
					[`${prefix}from`]: vec2(pixels(element.from, size)),
					[`${prefix}to`]: vec2(pixels(element.to, size))
				}
			};
		case 'ellipse':
			return {
				glsl: `ellipse_weight(q, u.${prefix}centre, u.${prefix}radii, u.${prefix}angle, u.${prefix}feather)`,
				uniforms: {
					[`${prefix}centre`]: vec2(pixels(element.centre, size)),
					[`${prefix}radii`]: vec2([element.radii[0] * size.width, element.radii[1] * size.width]),
					[`${prefix}angle`]: float(element.angle),
					[`${prefix}feather`]: float(element.feather)
				}
			};
		case 'area':
			return { glsl: `${areas.get(element.row)!}(p, reference)`, uniforms: {} };
	}
}

// Weights are fractions, so the set operations are the ones of independent
// fractions: product for intersection, and its dual for union.
const combined: Record<How, (e: string) => string> = {
	intersect: (e) => `w *= ${e};`,
	add: (e) => `w += (1.0 - w) * ${e};`,
	subtract: (e) => `w *= 1.0 - ${e};`
};

/**
 * A GLSL function `float ${name}(ivec2 p, Reference reference)` giving the
 * weight of `where` at a pixel, and the uniforms it reads. The weight depends
 * on the position and the reference only.
 */
export function weightFunction(
	name: string,
	where: Where,
	size: Size,
	areas: ReadonlyMap<number, string>
): Generated {
	const steps = where.map(({ how, element }, i) => {
		const { glsl, uniforms } = selected(`${name}_${i}_`, element, size, areas);
		return { glsl: combined[how](glsl), uniforms };
	});
	return {
		glsl: /* glsl */ `
float ${name}(ivec2 p, Reference reference) {
	vec2 q = vec2(p) + 0.5;
	float w = 1.0;
	${steps.map((step) => step.glsl).join('\n\t')}
	return w;
}`,
		uniforms: Object.assign({}, ...steps.map((step) => step.uniforms))
	};
}
