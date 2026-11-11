import type { Vec2 } from '../math/matrix';
import type { Chromaticity } from './spaces';

/**
 * A light source as photographers specify it. `tint` is the distance from the
 * blackbody locus in the CIE 1960 uv diagram, times 1000, positive towards
 * green. Raising it tells the pipeline the light was greener, so the picture
 * turns more magenta, as the tint slider does in other editors.
 */
export interface Illuminant {
	readonly temperature: number;
	readonly tint: number;
}

export const TEMPERATURE_RANGE = [1667, 25000] as const;

// Kang et al., "Design of advanced color temperature control system for HDTV
// applications", 2002: cubic fits to the blackbody locus, valid over TEMPERATURE_RANGE.
function blackbody(t: number): Chromaticity {
	const x =
		t < 4000
			? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
			: -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
	const y =
		t < 2222
			? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
			: t < 4000
				? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
				: 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
	return [x, y];
}

const toUv = ([x, y]: Chromaticity): Vec2 => {
	const d = -2 * x + 12 * y + 3;
	return [(4 * x) / d, (6 * y) / d];
};

const toXy = ([u, v]: Vec2): Chromaticity => {
	const d = 2 * u - 8 * v + 4;
	return [(3 * u) / d, (2 * v) / d];
};

/** Unit normal to the locus at `t`, pointing towards green (increasing v). */
function normal(t: number): Vec2 {
	const [u0, v0] = toUv(blackbody(t - 0.5));
	const [u1, v1] = toUv(blackbody(t + 0.5));
	const length = Math.hypot(u1 - u0, v1 - v0);
	const n: Vec2 = [-(v1 - v0) / length, (u1 - u0) / length];
	return n[1] > 0 ? n : [-n[0], -n[1]];
}

export function chromaticity({ temperature, tint }: Illuminant): Chromaticity {
	const [u, v] = toUv(blackbody(temperature));
	const [nu, nv] = normal(temperature);
	return toXy([u + (nu * tint) / 1000, v + (nv * tint) / 1000]);
}

/** Inverse of `chromaticity`: the nearest locus point and the signed distance from it. */
export function illuminant(xy: Chromaticity): Illuminant {
	const [u, v] = toUv(xy);
	const distance = (t: number) => {
		const [bu, bv] = toUv(blackbody(t));
		return Math.hypot(u - bu, v - bv);
	};
	// Golden-section search in log temperature; distance to the locus is unimodal over the range.
	const ratio = (Math.sqrt(5) - 1) / 2;
	let low = Math.log(TEMPERATURE_RANGE[0]);
	let high = Math.log(TEMPERATURE_RANGE[1]);
	while (high - low > 1e-12) {
		const a = high - ratio * (high - low);
		const b = low + ratio * (high - low);
		if (distance(Math.exp(a)) < distance(Math.exp(b))) high = b;
		else low = a;
	}
	const temperature = Math.exp((low + high) / 2);
	const [bu, bv] = toUv(blackbody(temperature));
	const [nu, nv] = normal(temperature);
	return { temperature, tint: ((u - bu) * nu + (v - bv) * nv) * 1000 };
}
