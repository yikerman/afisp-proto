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
 * What a module is allowed to compute. The kind fixes the signature of the
 * WGSL function the module supplies, and with it what the module can depend on:
 *
 * - `tone`: `fn name(reference: Reference, params: name_params) -> f32`, an
 *   exposure offset in stops. It sees only the reference, so tone terms add up
 *   in any order.
 * - `colour`: `fn name(rgb: vec3f, reference: Reference, params: name_params) -> vec3f`,
 *   scene-linear in and out, one pixel at a time.
 */
export type Kind = 'tone' | 'colour';

export interface Module<K extends Kind = Kind, P extends Params = Params> {
	readonly kind: K;
	/** Name of the WGSL function; its parameter struct is `${name}_params`. */
	readonly name: string;
	readonly params: P;
	/** Parameter values at which the module changes nothing. */
	readonly identity: Values<P>;
	readonly wgsl: string;
	/** Shared WGSL the function needs; included once however many modules ask for it. */
	readonly imports: readonly string[];
}

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
