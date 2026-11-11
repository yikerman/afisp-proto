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
 * Shifts every colour towards one hue, like the global wheel of darktable's
 * color balance rgb or the offset wheel in film grading. The shift is
 * proportional to lightness, which makes it the same at any exposure and
 * leaves black black.
 */
export const balance: Module<'colour', { readonly shift: 'vec2f' }> = {
	kind: 'colour',
	name: 'balance',
	params: { shift: 'vec2f' },
	identity: { shift: [0, 0] },
	imports: [oklabWgsl],
	wgsl: /* wgsl */ `
fn balance(rgb: vec3f, reference: Reference, params: balance_params) -> vec3f {
	let lab = oklab_from_scene(rgb);
	return scene_from_oklab(vec3f(lab.x, lab.yz + lab.x * params.shift));
}`
};
