import { srgbWgsl } from '../colour/srgb';
import type { Image, Size } from '../gpu/image';
import type { Pass } from '../gpu/pass';
import { f32, vec2f } from '../gpu/uniforms';
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

const wgsl = /* wgsl */ `
${srgbWgsl}

fn pixel(p: vec2i) -> vec4f {
	let first = vec2i(floor((vec2f(p) - u.size / 2) / u.scale + u.centre));
	let next = vec2i(floor((vec2f(p) + 1 - u.size / 2) / u.scale + u.centre));
	let limit = vec2i(textureDimensions(display)) - 1;
	// Outside the picture the output is transparent.
	if (any(first < vec2i(0)) || any(first > limit)) {
		return vec4f(0);
	}
	// Each output pixel is the mean of the image area it covers; averaging is done on light.
	let count = max(next - first, vec2i(1));
	var sum = vec3f(0);
	for (var y = 0; y < count.y; y++) {
		for (var x = 0; x < count.x; x++) {
			sum += srgb_decode(textureLoad(display, min(first + vec2i(x, y), limit), 0).rgb);
		}
	}
	return vec4f(srgb_encode(sum / f32(count.x * count.y)), 1);
}`;

export const resample = (
	display: Image<'display'>,
	view: View,
	format: 'rgba8unorm' | 'bgra8unorm'
): Pass => ({
	label: 'resample',
	wgsl,
	textures: { display },
	uniforms: {
		size: vec2f([view.size.width, view.size.height]),
		centre: vec2f(view.centre),
		scale: f32(view.scale)
	},
	size: view.size,
	format
});
