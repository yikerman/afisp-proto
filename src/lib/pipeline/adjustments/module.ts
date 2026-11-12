import type { Gpu } from '../../gpu/gpu';
import type { Image } from '../../gpu/image';
import type { Reference } from '../reference';
import type { Mask } from './mask';

/** WGSL types a module parameter can have. */
export type ParamType = 'f32' | 'vec2f' | `array<f32, ${number}>`;
export type Params = Readonly<Record<string, ParamType>>;

type Value<T extends ParamType> = T extends 'f32'
	? number
	: T extends 'vec2f'
		? readonly [number, number]
		: readonly number[];

export type Values<P extends Params> = { readonly [K in keyof P]: Value<P[K]> };

/**
 * What a module is allowed to compute. The kind fixes the module's signature,
 * and with it what the module can depend on. Kinds run in this order:
 *
 * - `tone`: `fn name(reference: Reference, params: name_params) -> f32`, an
 *   exposure offset in stops. It sees only the reference, so tone terms add up
 *   in any order.
 * - `colour`: `fn name(rgb: vec3f, reference: Reference, params: name_params) -> vec3f`,
 *   scene-linear in and out, one pixel at a time.
 * - `spatial`: image to image, where a pixel may depend on its neighbours.
 */
export type Kind = 'tone' | 'colour' | 'spatial';
export type ShaderKind = Exclude<Kind, 'spatial'>;

interface Described<K extends Kind, P extends Params> {
	readonly kind: K;
	/** Name of the module; for shader modules also of its WGSL function and `${name}_params`. */
	readonly name: string;
	readonly params: P;
	/** Parameter values at which the module changes nothing. */
	readonly identity: Values<P>;
}

export interface ShaderModule<
	K extends ShaderKind = ShaderKind,
	P extends Params = Params
> extends Described<K, P> {
	readonly wgsl: string;
	/** Shared WGSL the function needs; included once however many modules ask for it. */
	readonly imports: readonly string[];
}

export interface SpatialModule<P extends Params = Params> extends Described<'spatial', P> {
	/** Returns a new image and leaves `image` to its owner. */
	apply(gpu: Gpu, image: Image<'scene'>, reference: Reference, values: Values<P>): Image<'scene'>;
}

export type Module<K extends Kind = Kind, P extends Params = Params> = K extends ShaderKind
	? ShaderModule<K, P>
	: SpatialModule<P>;

export interface Instance<K extends Kind = Kind> {
	readonly module: Module<K>;
	readonly values: Values<Params>;
	readonly mask: Mask;
}

export const instance = <K extends Kind, P extends Params>(
	module: Module<K, P>,
	values: Values<P>,
	mask: Mask
): Instance<K> => ({ module: module as unknown as Module<K>, values, mask });

export const atIdentity = <K extends Kind, P extends Params>(
	module: Module<K, P>,
	mask: Mask
): Instance<K> => instance(module, module.identity, mask);

export const isKind =
	<K extends Kind>(kind: K) =>
	(i: Instance): i is Instance<K> =>
		i.module.kind === kind;
