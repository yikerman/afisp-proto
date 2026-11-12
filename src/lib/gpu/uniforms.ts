/** Column-major, as GLSL constructs matrices and `uniformMatrix3fv` takes them untransposed. */
export type Mat3 = readonly [
	number, number, number,
	number, number, number,
	number, number, number
]; // prettier-ignore

/** GLSL ES 3.00 types a uniform can have, with the values that set them. */
export type Uniform =
	| { readonly type: 'float'; readonly value: number }
	| { readonly type: 'vec2'; readonly value: readonly [number, number] }
	| { readonly type: 'vec3'; readonly value: readonly [number, number, number] }
	| { readonly type: 'vec4'; readonly value: readonly [number, number, number, number] }
	| { readonly type: 'mat3'; readonly value: Mat3 }
	| { readonly type: `float[${number}]`; readonly value: readonly number[] };

export type Uniforms = Readonly<Record<string, Uniform>>;

export const float = (value: number): Uniform => ({ type: 'float', value });
export const vec2 = (value: readonly [number, number]): Uniform => ({ type: 'vec2', value });
export const vec3 = (value: readonly [number, number, number]): Uniform => ({
	type: 'vec3',
	value
});
export const vec4 = (value: readonly [number, number, number, number]): Uniform => ({
	type: 'vec4',
	value
});
export const mat3 = (value: Mat3): Uniform => ({ type: 'mat3', value });
export const floats = (value: readonly number[]): Uniform => ({
	type: `float[${value.length}]`,
	value
});

/** `struct name { ... };`, one member per uniform, in GLSL's `type[n] name` array syntax. */
export function structDeclaration(name: string, uniforms: Uniforms): string {
	const members = Object.entries(uniforms).map(([member, u]) => `\t${u.type} ${member};`);
	return `struct ${name} {\n${members.join('\n')}\n};`;
}

/** Sets `uniform` at `location`; a null location is a uniform the compiler removed as unused. */
export function setUniform(
	gl: WebGL2RenderingContext,
	location: WebGLUniformLocation | null,
	uniform: Uniform
): void {
	switch (uniform.type) {
		case 'float':
			return gl.uniform1f(location, uniform.value);
		case 'vec2':
			return gl.uniform2fv(location, new Float32Array(uniform.value));
		case 'vec3':
			return gl.uniform3fv(location, new Float32Array(uniform.value));
		case 'vec4':
			return gl.uniform4fv(location, new Float32Array(uniform.value));
		case 'mat3':
			return gl.uniformMatrix3fv(location, false, new Float32Array(uniform.value));
		default:
			return gl.uniform1fv(location, new Float32Array(uniform.value));
	}
}
