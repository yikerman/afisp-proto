import { run } from '../../gpu/pass';
import { f32 } from '../../gpu/uniforms';
import { smooth, stopsOf, type Smoothing } from '../reference';
import type { Module } from './module';

/** Narrow enough to follow shapes, wide enough to leave fine texture and noise alone. */
const DETAIL: Smoothing = { radius: 0.01, edgeVariance: 0.25 };

const wgsl = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	let detail = textureLoad(stops, p, 0).r - textureLoad(base, p, 0).r;
	return vec4f(textureLoad(image, p, 0).rgb * exp2(u.amount * detail), 1);
}`;

/**
 * Scales how far each pixel stands out from its surroundings, in stops, in the
 * graded image: what the picture shows, not what the scene held. Edges are
 * excluded from the surroundings, so they do not grow halos.
 */
export const localContrast: Module<'spatial', { readonly amount: 'f32' }> = {
	kind: 'spatial',
	name: 'local_contrast',
	params: { amount: 'f32' },
	identity: { amount: 0 },
	apply(gpu, image, _reference, { amount }) {
		const stops = stopsOf(gpu, image);
		const base = smooth(gpu, stops, DETAIL);
		const result = run<'scene'>(gpu, {
			label: 'local contrast',
			wgsl,
			textures: { image, stops, base },
			uniforms: { amount: f32(amount) },
			size: image,
			format: 'rgba16float'
		});
		stops.destroy();
		base.destroy();
		return result;
	}
};
