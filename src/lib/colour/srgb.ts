/** The sRGB transfer function and its inverse (IEC 61966-2-1), per channel. */
export const srgbWgsl = /* wgsl */ `
fn srgb_encode(linear: vec3f) -> vec3f {
	return select(1.055 * pow(linear, vec3f(1 / 2.4)) - 0.055, 12.92 * linear, linear <= vec3f(0.0031308));
}

fn srgb_decode(encoded: vec3f) -> vec3f {
	return select(pow((encoded + 0.055) / 1.055, vec3f(2.4)), encoded / 12.92, encoded <= vec3f(0.04045));
}`;
