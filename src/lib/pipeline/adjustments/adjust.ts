import type { Gpu } from '../../gpu/gpu';
import type { Image } from '../../gpu/image';
import { run } from '../../gpu/pass';
import { f32, vec2f, type Uniform, type Uniforms } from '../../gpu/uniforms';
import { referenceTextures, referenceWgsl, type Reference } from '../reference';
import { maskWgsl } from './mask';
import { isKind, type Instance, type Module, type ParamType } from './module';

// A module's parameters reach its function as a struct built from uniforms.
// Uniform buffers cannot hold arrays of f32, so an array is one uniform per element.

type Field = { readonly name: string; readonly type: ParamType; readonly value: unknown };

const fields = ({ module, values }: Instance): Field[] =>
	Object.entries(module.params).map(([name, type]) => ({ name, type, value: values[name] }));

function uniforms(prefix: string, i: Instance): Uniforms {
	const entries = fields(i).flatMap(({ name, type, value }): [string, Uniform][] => {
		switch (type) {
			case 'f32':
				return [[`${prefix}${name}`, f32(value as number)]];
			case 'vec2f':
				return [[`${prefix}${name}`, vec2f(value as readonly [number, number])]];
			default:
				return (value as readonly number[]).map((v, k) => [`${prefix}${name}_${k}`, f32(v)]);
		}
	});
	return Object.fromEntries(entries);
}

function argument(prefix: string, i: Instance): string {
	const members = fields(i).map(({ name, type, value }) =>
		type === 'f32' || type === 'vec2f'
			? `u.${prefix}${name}`
			: `${type}(${(value as readonly number[]).map((_, k) => `u.${prefix}${name}_${k}`).join(', ')})`
	);
	return `${i.module.name}_params(${members.join(', ')})`;
}

function declaration(module: Module): string {
	const members = Object.entries(module.params).map(([name, type]) => `\t${name}: ${type},`);
	return `struct ${module.name}_params {\n${members.join('\n')}\n}\n${module.wgsl}`;
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

function shader(instances: readonly Instance[], statement: (call: Call) => string, body: string) {
	const modules = unique(instances.map((i) => i.module));
	const statements = instances.map((i, k) =>
		statement({ mask: maskWgsl(i.mask), name: i.module.name, params: argument(`i${k}_`, i) })
	);
	return [
		referenceWgsl,
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

const allUniforms = (instances: readonly Instance[]): Uniforms =>
	Object.assign({}, ...instances.map((i, k) => uniforms(`i${k}_`, i)));

/** Relighting: every tone term is an exposure offset computed from the reference; they add. */
function relight(gpu: Gpu, reference: Reference, terms: readonly Instance<'tone'>[]) {
	return run<'scene'>(gpu, {
		label: 'tone',
		wgsl: shader(
			terms,
			({ mask, name, params }) => `stops += (${mask}) * ${name}(reference, ${params});`,
			/* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	let reference = reference_at(p);
	var stops = 0.0;
	STATEMENTS
	return vec4f(reference.scene * exp2(stops), 1);
}`
		),
		textures: referenceTextures(reference),
		uniforms: allUniforms(terms),
		size: reference.scene,
		format: 'rgba16float'
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
		wgsl: shader(
			operations,
			({ mask, name, params }) => `rgb = mix(rgb, ${name}(rgb, reference, ${params}), ${mask});`,
			/* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	let reference = reference_at(p);
	var rgb = textureLoad(image, p, 0).rgb;
	STATEMENTS
	// Colours pushed outside Rec.2020 are clipped to it; the scene encoding is non-negative.
	return vec4f(max(rgb, vec3f(0)), 1);
}`
		),
		textures: { ...referenceTextures(reference), image },
		uniforms: allUniforms(operations),
		size: reference.scene,
		format: 'rgba16float'
	});
}

/** The creative stage: scene to graded scene. Leaves the reference untouched. */
export function adjust(
	gpu: Gpu,
	reference: Reference,
	instances: readonly Instance[]
): Image<'scene'> {
	const relit = relight(gpu, reference, instances.filter(isKind('tone')));
	const graded = colour(gpu, reference, relit, instances.filter(isKind('colour')));
	relit.destroy();
	return graded;
}
