import type { Gpu } from '../../gpu/gpu';
import type { Image } from '../../gpu/image';
import { run } from '../../gpu/pass';
import { f32, vec2f, vec4f } from '../../gpu/uniforms';
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

const wgsl = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	let site = (p.y & 1) * 2 + (p.x & 1);
	let counts = f32(textureLoad(sensor, p + vec2i(u.origin), 0).r);
	let linear = (counts - u.black[site]) / (u.white - u.black[site]);
	return vec4f(clamp(linear * u.gain[site], 0, 1), 0, 0, 1);
}`;

/** Crops to the active area, removes the black level and scales clipping to 1. */
export function linearise(gpu: Gpu, sensor: Image<'sensor'>, meta: RawMeta): Image<'mosaic'> {
	const gains = demosaicGains(meta);
	const [a, b, c, d] = meta.pattern;
	return run(gpu, {
		label: 'linearise',
		wgsl,
		textures: { sensor },
		uniforms: {
			origin: vec2f([meta.active.x, meta.active.y]),
			black: vec4f(meta.black),
			white: f32(meta.white),
			gain: vec4f([gains[a], gains[b], gains[c], gains[d]])
		},
		size: meta.active,
		format: 'r32float'
	});
}
