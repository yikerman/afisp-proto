/** The sRGB transfer function and its inverse (IEC 61966-2-1), per channel. */
export const srgbGlsl = /* glsl */ `
vec3 srgb_encode(vec3 linear) {
	return mix(1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055, 12.92 * linear, lessThanEqual(linear, vec3(0.0031308)));
}

vec3 srgb_decode(vec3 encoded) {
	return mix(pow((encoded + 0.055) / 1.055, vec3(2.4)), encoded / 12.92, lessThanEqual(encoded, vec3(0.04045)));
}`;
