import { srgbWgsl } from '../colour/srgb';
import type { Image, Size } from '../gpu/image';
import type { Pass } from '../gpu/pass';
import { vec2f } from '../gpu/uniforms';

const wgsl = /* wgsl */ `
${srgbWgsl}

fn pixel(p: vec2i) -> vec4f {
	let scale = vec2f(textureDimensions(display)) / u.size;
	let first = vec2i(floor(vec2f(p) * scale));
	let count = max(vec2i(floor(vec2f(p + 1) * scale)) - first, vec2i(1));
	// Averaging is done on light, not on encoded values.
	var sum = vec3f(0);
	for (var y = 0; y < count.y; y++) {
		for (var x = 0; x < count.x; x++) {
			sum += srgb_decode(textureLoad(display, first + vec2i(x, y), 0).rgb);
		}
	}
	return vec4f(srgb_encode(sum / f32(count.x * count.y)), 1);
}`;

/** The display image at another size, each output pixel the mean of the area it covers. */
export const resample = (
	display: Image<'display'>,
	size: Size,
	format: 'rgba8unorm' | 'bgra8unorm'
): Pass => ({
	label: 'resample',
	wgsl,
	textures: { display },
	uniforms: { size: vec2f([size.width, size.height]) },
	size,
	format
});
