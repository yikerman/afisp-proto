import { srgbGlsl } from '../colour/srgb';
import type { Image, Size } from '../gpu/image';
import type { Pass } from '../gpu/pass';
import { float, vec2 } from '../gpu/uniforms';
import type { Vec2 } from '../math/matrix';

/** How the display image is laid onto an output of `size` pixels. */
export interface View {
	readonly size: Size;
	/** Output pixels per image pixel. */
	readonly scale: number;
	/** The image point shown at the output's centre, in image pixels. */
	readonly centre: Vec2;
}

/** The whole image, as large as fits. */
export const fit = (image: Size, size: Size): View => ({
	size,
	scale: Math.min(size.width / image.width, size.height / image.height),
	centre: [image.width / 2, image.height / 2]
});

/** The image point under an output pixel position. */
export const imagePoint = (view: View, [x, y]: Vec2): Vec2 => [
	view.centre[0] + (x - view.size.width / 2) / view.scale,
	view.centre[1] + (y - view.size.height / 2) / view.scale
];

const glsl = /* glsl */ `
${srgbGlsl}

vec4 pixel(ivec2 p) {
	ivec2 first = ivec2(floor((vec2(p) - u.size / 2.0) / u.scale + u.centre));
	ivec2 next = ivec2(floor((vec2(p) + 1.0 - u.size / 2.0) / u.scale + u.centre));
	ivec2 limit = textureSize(display, 0) - 1;
	// Outside the picture the output is transparent.
	if (any(lessThan(first, ivec2(0))) || any(greaterThan(first, limit))) {
		return vec4(0);
	}
	// Each output pixel is the mean of the image area it covers; averaging is done on light.
	ivec2 count = max(next - first, ivec2(1));
	vec3 sum = vec3(0);
	for (int y = 0; y < count.y; y++) {
		for (int x = 0; x < count.x; x++) {
			sum += srgb_decode(texelFetch(display, min(first + ivec2(x, y), limit), 0).rgb);
		}
	}
	return vec4(srgb_encode(sum / float(count.x * count.y)), 1);
}`;

export const resample = (display: Image<'display'>, view: View): Pass & { format: 'RGBA8' } => ({
	label: 'resample',
	glsl,
	textures: { display },
	uniforms: {
		size: vec2([view.size.width, view.size.height]),
		centre: vec2(view.centre),
		scale: float(view.scale)
	},
	size: view.size,
	format: 'RGBA8'
});
