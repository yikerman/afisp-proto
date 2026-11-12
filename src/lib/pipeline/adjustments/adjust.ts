import type { Gpu } from '../../gpu/gpu';
import type { Image } from '../../gpu/image';
import { run } from '../../gpu/pass';
import type { Uniform, Uniforms } from '../../gpu/uniforms';
import { referenceGlsl, referenceTextures, type Reference } from '../reference';
import { maskGlsl } from './mask';
import {
	isKind,
	type Instance,
	type ParamType,
	type ShaderKind,
	type ShaderModule
} from './module';
import type { Mask } from './mask';

// A module's parameters reach its function as a struct built from uniforms of the same types.

type Field = { readonly name: string; readonly type: ParamType; readonly value: unknown };

const fields = ({ module, values }: Instance<ShaderKind>): Field[] =>
	Object.entries(module.params).map(([name, type]) => ({ name, type, value: values[name] }));

const uniforms = (prefix: string, i: Instance<ShaderKind>): Uniforms =>
	Object.fromEntries(
		fields(i).map(({ name, type, value }) => [`${prefix}${name}`, { type, value } as Uniform])
	);

const argument = (prefix: string, i: Instance<ShaderKind>): string =>
	`${i.module.name}_params(${fields(i)
		.map(({ name }) => `u.${prefix}${name}`)
		.join(', ')})`;

function declaration(module: ShaderModule): string {
	const members = Object.entries(module.params).map(([name, type]) => `\t${type} ${name};`);
	return `struct ${module.name}_params {\n${members.join('\n')}\n};\n${module.glsl}`;
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

function shader(
	instances: readonly Instance<ShaderKind>[],
	statement: (call: Call) => string,
	body: string
) {
	const modules = unique(instances.map((i) => i.module));
	const statements = instances.map((i, k) =>
		statement({ mask: maskGlsl(i.mask), name: i.module.name, params: argument(`i${k}_`, i) })
	);
	return [
		referenceGlsl,
		...unique(modules.flatMap((m) => m.imports)),
		...modules.map(declaration),
		body.replace('STATEMENTS', statements.join('\n\t'))
	].join('\n');
}

interface Call {
	readonly mask: string;
	readonly name: string;
	readonly params: string;
}

const allUniforms = (instances: readonly Instance<ShaderKind>[]): Uniforms =>
	Object.assign({}, ...instances.map((i, k) => uniforms(`i${k}_`, i)));

/** Relighting: every tone term is an exposure offset computed from the reference; they add. */
function relight(gpu: Gpu, reference: Reference, terms: readonly Instance<'tone'>[]) {
	return run<'scene'>(gpu, {
		label: 'tone',
		glsl: shader(
			terms,
			({ mask, name, params }) => `stops += (${mask}) * ${name}(reference, ${params});`,
			/* glsl */ `
vec4 pixel(ivec2 p) {
	Reference reference = reference_at(p);
	float stops = 0.0;
	STATEMENTS
	return vec4(reference.scene * exp2(stops), 1);
}`
		),
		textures: referenceTextures(reference),
		uniforms: allUniforms(terms),
		size: reference.scene,
		format: 'RGBA16F'
	});
}

/** Colour operations run in the order given, each on the result of the one before. */
function colour(
	gpu: Gpu,
	reference: Reference,
	image: Image<'scene'>,
	operations: readonly Instance<'colour'>[]
) {
	return run<'scene'>(gpu, {
		label: 'colour',
		glsl: shader(
			operations,
			({ mask, name, params }) => `rgb = mix(rgb, ${name}(rgb, reference, ${params}), ${mask});`,
			/* glsl */ `
vec4 pixel(ivec2 p) {
	Reference reference = reference_at(p);
	vec3 rgb = texelFetch(image, p, 0).rgb;
	STATEMENTS
	// Colours pushed outside Rec.2020 are clipped to it; the scene encoding is non-negative.
	return vec4(max(rgb, vec3(0)), 1);
}`
		),
		textures: { ...referenceTextures(reference), image },
		uniforms: allUniforms(operations),
		size: reference.scene,
		format: 'RGBA16F'
	});
}

/** `after` where the mask is 1, `before` where it is 0. */
function blend(
	gpu: Gpu,
	reference: Reference,
	before: Image<'scene'>,
	after: Image<'scene'>,
	mask: Mask
) {
	return run<'scene'>(gpu, {
		label: 'blend',
		glsl: `${referenceGlsl}
vec4 pixel(ivec2 p) {
	Reference reference = reference_at(p);
	return mix(texelFetch(before, p, 0), texelFetch(after, p, 0), ${maskGlsl(mask)});
}`,
		textures: { ...referenceTextures(reference), before, after },
		uniforms: {},
		size: reference.scene,
		format: 'RGBA16F'
	});
}

/** Spatial operations run in the order given, each on the result of the one before. */
function spatial(
	gpu: Gpu,
	reference: Reference,
	image: Image<'scene'>,
	operations: readonly Instance<'spatial'>[]
) {
	return operations.reduce((before, { module, values, mask }) => {
		const after = module.apply(gpu, before, reference, values);
		const blended = blend(gpu, reference, before, after, mask);
		before.destroy();
		after.destroy();
		return blended;
	}, image);
}

/** The creative stage: scene to graded scene. Leaves the reference untouched. */
export function adjust(
	gpu: Gpu,
	reference: Reference,
	instances: readonly Instance[]
): Image<'scene'> {
	const relit = relight(gpu, reference, instances.filter(isKind('tone')));
	const coloured = colour(gpu, reference, relit, instances.filter(isKind('colour')));
	relit.destroy();
	return spatial(gpu, reference, coloured, instances.filter(isKind('spatial')));
}
