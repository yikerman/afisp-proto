import type { Gpu } from '../../gpu/gpu';
import type { Image } from '../../gpu/image';
import { run } from '../../gpu/pass';
import { float, vec2, vec4 } from '../../gpu/uniforms';
import type { Vec3 } from '../../math/matrix';
import type { RawMeta } from '../../raw/decode';

/**
 * Gains applied to the mosaic so demosaicing sees balanced channels. Scaled so
 * the smallest is 1: every channel then reaches 1 before or at sensor clipping,
 * and clipping at 1 leaves blown areas neutral instead of tinted.
 */
export function demosaicGains(meta: RawMeta): Vec3 {
	const least = Math.min(...meta.asShotGains);
	return [meta.asShotGains[0] / least, meta.asShotGains[1] / least, meta.asShotGains[2] / least];
}

const glsl = /* glsl */ `
vec4 pixel(ivec2 p) {
	int site = (p.y & 1) * 2 + (p.x & 1);
	float counts = float(texelFetch(sensor, p + ivec2(u.origin), 0).r);
	float linear = (counts - u.black[site]) / (u.white - u.black[site]);
	return vec4(clamp(linear * u.gain[site], 0.0, 1.0), 0, 0, 1);
}`;

/** Crops to the active area, removes the black level and scales clipping to 1. */
export function linearise(gpu: Gpu, sensor: Image<'sensor'>, meta: RawMeta): Image<'mosaic'> {
	const gains = demosaicGains(meta);
	const [a, b, c, d] = meta.pattern;
	return run(gpu, {
		label: 'linearise',
		glsl,
		textures: { sensor },
		uniforms: {
			origin: vec2([meta.active.x, meta.active.y]),
			black: vec4(meta.black),
			white: float(meta.white),
			gain: vec4([gains[a], gains[b], gains[c], gains[d]])
		},
		size: meta.active,
		format: 'R32F'
	});
}
