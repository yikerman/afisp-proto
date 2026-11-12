/**
 * A GLSL float literal for `x`. GLSL ES 3.00 converts no int to float
 * implicitly, so an integral value needs its decimal point.
 */
export function glslFloat(x: number): string {
	const text = String(x);
	return /[.e]/.test(text) ? text : `${text}.0`;
}
