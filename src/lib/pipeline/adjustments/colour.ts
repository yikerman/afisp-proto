import { oklabWgsl } from '../../colour/oklab';
import type { Module } from './module';

export const saturation: Module<'colour', { readonly amount: 'f32' }> = {
	kind: 'colour',
	name: 'saturation',
	params: { amount: 'f32' },
	identity: { amount: 1 },
	imports: [oklabWgsl],
	wgsl: /* wgsl */ `
fn saturation(rgb: vec3f, reference: Reference, params: saturation_params) -> vec3f {
	let lab = oklab_from_scene(rgb);
	return scene_from_oklab(vec3f(lab.x, lab.yz * params.amount));
}`
};

/**
 * Shifts colours towards a hue, for the whole picture and per tonal zone, like
 * darktable's color balance rgb or the wheels of film grading. A shift is
 * proportional to lightness, which makes it the same at any exposure and
 * leaves black black.
 *
 * The zones are read from the reference, four stops either side of middle
 * grey, and their weights sum to one: equal shifts in all three are the same
 * as a global shift.
 */
export const balance: Module<
	'colour',
	{
		readonly global: 'vec2f';
		readonly shadows: 'vec2f';
		readonly midtones: 'vec2f';
		readonly highlights: 'vec2f';
	}
> = {
	kind: 'colour',
	name: 'balance',
	params: { global: 'vec2f', shadows: 'vec2f', midtones: 'vec2f', highlights: 'vec2f' },
	identity: { global: [0, 0], shadows: [0, 0], midtones: [0, 0], highlights: [0, 0] },
	imports: [oklabWgsl],
	wgsl: /* wgsl */ `
fn balance(rgb: vec3f, reference: Reference, params: balance_params) -> vec3f {
	let t = clamp((reference.smoothed_stops + 4) / 8, 0, 1);
	let shift = params.global
		+ (1 - t) * (1 - t) * params.shadows
		+ 2 * t * (1 - t) * params.midtones
		+ t * t * params.highlights;
	let lab = oklab_from_scene(rgb);
	return scene_from_oklab(vec3f(lab.x, lab.yz + lab.x * shift));
}`
};
