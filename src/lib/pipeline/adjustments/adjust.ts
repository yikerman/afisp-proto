import { oklabGlsl } from '../../colour/oklab';
import type { Gpu } from '../../gpu/gpu';
import type { Image, Texture } from '../../gpu/image';
import { run } from '../../gpu/pass';
import { vec2, vec4, type Uniforms } from '../../gpu/uniforms';
import { referenceGlsl, referenceTextures, type Reference } from '../reference';
import type { Row, Rows } from './row';
import { weightFunction, whereGlsl } from './where';

// Every row contributes its settings, weighted by where it applies; the sums are
// then applied once. Nothing here reads anything but the reference, and a sum
// has no order, so rows can be listed, added and removed freely.

interface Weights {
	readonly glsl: string;
	readonly uniforms: Uniforms;
}

/** `weight_0` … `weight_{n-1}`: one function per row. */
function weights(rows: readonly Row[], reference: Reference): Weights {
	const each = rows.map((row, k) => weightFunction(`weight_${k}`, row.where, reference.scene));
	return {
		glsl: [referenceGlsl, whereGlsl, ...each.map((w) => w.glsl)].join('\n'),
		uniforms: Object.assign({}, ...each.map((w) => w.uniforms))
	};
}

// Points of the picture sampled to find an area's average tone.
const GRID = [96, 64] as const;

/**
 * The average tone of each row's area, one row per pixel along x. Contrast
 * turns about it, so contrast alone leaves an area as light as it was.
 */
function averageTones(gpu: Gpu, reference: Reference, rows: Rows, { glsl, uniforms }: Weights) {
	const cases = rows.map((_, k) => `if (row == ${k}) return weight_${k}(p, reference);`);
	return run(gpu, {
		label: 'average tones',
		glsl: /* glsl */ `${glsl}
float weight(int row, ivec2 p, Reference reference) {
	${cases.join('\n\t')}
	return 0.0;
}

vec4 pixel(ivec2 p) {
	vec2 size = vec2(textureSize(scene, 0));
	vec2 sum = vec2(0);
	for (int j = 0; j < ${GRID[1]}; j++) {
		for (int i = 0; i < ${GRID[0]}; i++) {
			ivec2 at = ivec2((vec2(i, j) + 0.5) / vec2(${GRID[0]}, ${GRID[1]}) * size);
			Reference reference = reference_at(at);
			float w = weight(p.x, at, reference);
			sum += vec2(w * reference.smoothed_stops, w);
		}
	}
	// An area that covers nothing has no average, and nothing to apply it to.
	return vec4(sum.y > 0.0 ? sum.x / sum.y : 0.0, 0, 0, 1);
}`,
		textures: referenceTextures(reference),
		uniforms,
		size: { width: rows.length, height: 1 },
		format: 'RGBA32F'
	});
}

/** The creative stage: scene to graded scene. Leaves the reference untouched. */
export function adjust(gpu: Gpu, reference: Reference, rows: Rows): Image<'scene'> {
	const where = weights(rows, reference);
	const averages = averageTones(gpu, reference, rows, where);
	const contributions = rows.map(
		(_, k) => /* glsl */ `{
		float w = weight_${k}(p, reference);
		float average = texelFetch(averages, ivec2(${k}, 0), 0).r;
		vec4 what = u.what_${k};
		stops += w * (what.x + (what.y - 1.0) * (base - average) + what.z * detail);
		saturation += w * (what.w - 1.0);
		shift += w * u.colour_${k};
	}`
	);
	const graded = run<'scene'>(gpu, {
		label: 'adjust',
		glsl: /* glsl */ `${where.glsl}
${oklabGlsl}

vec4 pixel(ivec2 p) {
	Reference reference = reference_at(p);
	float base = reference.smoothed_stops;
	float detail = reference.stops - base;
	float stops = 0.0;
	float saturation = 1.0;
	vec2 shift = vec2(0);
	${contributions.join('\n\t')}
	vec3 lab = oklab_from_scene(reference.scene * exp2(stops));
	// A colour shift is proportional to lightness, so it is the same at any exposure.
	lab.yz = lab.yz * max(saturation, 0.0) + lab.x * shift;
	// Colours pushed outside Rec.2020 are clipped to it; the scene encoding is non-negative.
	return vec4(max(scene_from_oklab(lab), vec3(0)), 1);
}`,
		textures: { ...referenceTextures(reference), averages },
		uniforms: {
			...where.uniforms,
			...Object.fromEntries(
				rows.flatMap(({ what }, k) => [
					[`what_${k}`, vec4([what.lightness, what.contrast, what.detail, what.saturation])],
					[`colour_${k}`, vec2(what.colour)]
				])
			)
		},
		size: reference.scene,
		format: 'RGBA16F'
	});
	averages.destroy();
	return graded;
}

/** `display` with the area a row applies to marked in colour. */
export function markArea(
	gpu: Gpu,
	reference: Reference,
	row: Row,
	display: Image<'display'>
): Image<'display'> {
	const where = weights([row], reference);
	return run<'display'>(gpu, {
		label: 'mark area',
		glsl: /* glsl */ `${where.glsl}
vec4 pixel(ivec2 p) {
	float w = weight_0(p, reference_at(p));
	return vec4(mix(texelFetch(display, p, 0).rgb, vec3(0.95, 0.25, 0.2), 0.6 * w), 1);
}`,
		textures: { ...referenceTextures(reference), display: display as Texture },
		uniforms: where.uniforms,
		size: display,
		format: 'RGBA16F'
	});
}
