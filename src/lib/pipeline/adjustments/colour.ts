import { oklabGlsl } from '../../colour/oklab';
import type { Module } from './module';

export const saturation: Module<'colour', { readonly amount: 'float' }> = {
	kind: 'colour',
	name: 'saturation',
	params: { amount: 'float' },
	identity: { amount: 1 },
	imports: [oklabGlsl],
	glsl: /* glsl */ `
vec3 saturation(vec3 rgb, Reference reference, saturation_params params) {
	vec3 lab = oklab_from_scene(rgb);
	return scene_from_oklab(vec3(lab.x, lab.yz * params.amount));
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
		readonly global: 'vec2';
		readonly shadows: 'vec2';
		readonly midtones: 'vec2';
		readonly highlights: 'vec2';
	}
> = {
	kind: 'colour',
	name: 'balance',
	params: { global: 'vec2', shadows: 'vec2', midtones: 'vec2', highlights: 'vec2' },
	identity: { global: [0, 0], shadows: [0, 0], midtones: [0, 0], highlights: [0, 0] },
	imports: [oklabGlsl],
	glsl: /* glsl */ `
vec3 balance(vec3 rgb, Reference reference, balance_params params) {
	float t = clamp((reference.smoothed_stops + 4.0) / 8.0, 0.0, 1.0);
	vec2 shift = params.global
		+ (1.0 - t) * (1.0 - t) * params.shadows
		+ 2.0 * t * (1.0 - t) * params.midtones
		+ t * t * params.highlights;
	vec3 lab = oklab_from_scene(rgb);
	return scene_from_oklab(vec3(lab.x, lab.yz + lab.x * shift));
}`
};
