import type { Mat3 } from '../gpu/uniforms';

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
/** Rows, as matrices are written on paper: `m[row][column]`. */
export type Matrix3 = readonly [Vec3, Vec3, Vec3];

export const identity: Matrix3 = [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1]
];

export const diagonal = (d: Vec3): Matrix3 => [
	[d[0], 0, 0],
	[0, d[1], 0],
	[0, 0, d[2]]
];

export const transform = (m: Matrix3, v: Vec3): Vec3 => [
	m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
	m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
	m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
];

const column = (m: Matrix3, j: 0 | 1 | 2): Vec3 => [m[0][j], m[1][j], m[2][j]];

export const transpose = (m: Matrix3): Matrix3 => [column(m, 0), column(m, 1), column(m, 2)];

/** `multiply(a, b)` applies `b` first. */
export const multiply = (a: Matrix3, b: Matrix3): Matrix3 =>
	transpose([transform(a, column(b, 0)), transform(a, column(b, 1)), transform(a, column(b, 2))]);

export const compose = (...ms: readonly Matrix3[]): Matrix3 => ms.reduce(multiply, identity);

const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0]
];

const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

export function inverse(m: Matrix3): Matrix3 {
	const [a, b, c] = m;
	const cofactors: Matrix3 = [cross(b, c), cross(c, a), cross(a, b)];
	const determinant = a[0] * cofactors[0][0] + a[1] * cofactors[0][1] + a[2] * cofactors[0][2];
	const [x, y, z] = transpose(cofactors);
	return [scale(x, 1 / determinant), scale(y, 1 / determinant), scale(z, 1 / determinant)];
}

export const columnMajor = (m: Matrix3): Mat3 =>
	[...column(m, 0), ...column(m, 1), ...column(m, 2)] as unknown as Mat3;

/** A WGSL `mat3x3f` constructor expression (which takes columns). */
export const wgslMatrix = (m: Matrix3): string => `mat3x3f(${columnMajor(m).join(', ')})`;

export const wgslVector = (v: Vec3): string => `vec3f(${v.join(', ')})`;
