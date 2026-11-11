/** Column-major, as WGSL constructs and stores matrices. */
export type Mat3 = readonly [
	number, number, number,
	number, number, number,
	number, number, number
]; // prettier-ignore

export type Uniform =
	| { readonly type: 'f32'; readonly value: number }
	| { readonly type: 'vec2f'; readonly value: readonly [number, number] }
	| { readonly type: 'vec3f'; readonly value: readonly [number, number, number] }
	| { readonly type: 'vec4f'; readonly value: readonly [number, number, number, number] }
	| { readonly type: 'mat3x3f'; readonly value: Mat3 };

export type Uniforms = Readonly<Record<string, Uniform>>;

export const f32 = (value: number): Uniform => ({ type: 'f32', value });
export const vec2f = (value: readonly [number, number]): Uniform => ({ type: 'vec2f', value });
export const vec3f = (value: readonly [number, number, number]): Uniform => ({
	type: 'vec3f',
	value
});
export const vec4f = (value: readonly [number, number, number, number]): Uniform => ({
	type: 'vec4f',
	value
});
export const mat3x3f = (value: Mat3): Uniform => ({ type: 'mat3x3f', value });

// WGSL host-shareable layout (https://www.w3.org/TR/WGSL/#alignment-and-size), in floats.
const layout: Record<Uniform['type'], { align: number; size: number }> = {
	f32: { align: 1, size: 1 },
	vec2f: { align: 2, size: 2 },
	vec3f: { align: 4, size: 3 },
	vec4f: { align: 4, size: 4 },
	mat3x3f: { align: 4, size: 12 }
};

const roundUp = (n: number, multiple: number) => Math.ceil(n / multiple) * multiple;

export function structDeclaration(name: string, uniforms: Uniforms): string {
	const fields = Object.entries(uniforms).map(([field, u]) => `\t${field}: ${u.type},`);
	return `struct ${name} {\n${fields.join('\n')}\n}`;
}

export function pack(uniforms: Uniforms): Float32Array<ArrayBuffer> {
	const placed: { offset: number; uniform: Uniform }[] = [];
	let end = 0;
	for (const uniform of Object.values(uniforms)) {
		const { align, size } = layout[uniform.type];
		const offset = roundUp(end, align);
		placed.push({ offset, uniform });
		end = offset + size;
	}
	const data = new Float32Array(roundUp(end, 4));
	for (const { offset, uniform } of placed) {
		switch (uniform.type) {
			case 'f32':
				data[offset] = uniform.value;
				break;
			case 'vec2f':
			case 'vec3f':
			case 'vec4f':
				data.set(uniform.value, offset);
				break;
			case 'mat3x3f':
				// Each column is a vec3f, aligned to 4 floats.
				for (let column = 0; column < 3; column++) {
					data.set(uniform.value.slice(column * 3, column * 3 + 3), offset + column * 4);
				}
				break;
		}
	}
	return data;
}
