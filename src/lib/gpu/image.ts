import type { Gpu } from './gpu';

declare const encoding: unique symbol;

/**
 * What the numbers in a texture mean. The pipeline's stage contracts are stated
 * in these terms, so passing an image to the wrong stage is a type error.
 */
export type Encoding =
	/** Sensor counts as stored in the file, one channel, colour filter mosaic. */
	| 'sensor'
	/** Mosaic, linear, 0 = black level, 1 = clipping, channels balanced for demosaicing. */
	| 'mosaic'
	/** Demosaiced camera RGB, same scale as 'mosaic'. */
	| 'camera'
	/** Scene-linear Rec.2020, non-negative, neutral is R=G=B, middle grey at Y = MIDDLE_GREY. */
	| 'scene'
	/** One channel: exposure in stops (log2 ratio). */
	| 'stops'
	/** One channel in [0, 1]. */
	| 'mask'
	/** Display-referred, encoded for the output profile. */
	| 'display';

export type Image<E extends Encoding> = GPUTexture & { readonly [encoding]: E };

export type Format =
	'r16uint' | 'r32float' | 'rgba16float' | 'rgba32float' | 'rgba8unorm' | 'bgra8unorm';

export interface Size {
	readonly width: number;
	readonly height: number;
}

const usage =
	GPUTextureUsage.TEXTURE_BINDING |
	GPUTextureUsage.RENDER_ATTACHMENT |
	GPUTextureUsage.COPY_SRC |
	GPUTextureUsage.COPY_DST;

export function createImage<E extends Encoding>(
	gpu: Gpu,
	label: string,
	size: Size,
	format: Format
): Image<E> {
	return gpu.device.createTexture({
		label,
		size: [size.width, size.height],
		format,
		usage
	}) as Image<E>;
}

const bytesPerPixel: Record<Format, number> = {
	r16uint: 2,
	r32float: 4,
	rgba16float: 8,
	rgba32float: 16,
	rgba8unorm: 4,
	bgra8unorm: 4
};

type PixelArray = Uint16Array | Float32Array | Float16Array | Uint8Array;

export function upload<E extends Encoding>(
	gpu: Gpu,
	label: string,
	size: Size,
	format: Format,
	pixels: PixelArray
): Image<E> {
	const image = createImage<E>(gpu, label, size, format);
	gpu.device.queue.writeTexture(
		{ texture: image },
		pixels as GPUAllowSharedBufferSource,
		{ bytesPerRow: size.width * bytesPerPixel[format] },
		[size.width, size.height]
	);
	return image;
}

/** Tightly packed bytes of the whole texture, row padding removed. */
export async function download(gpu: Gpu, image: GPUTexture): Promise<ArrayBuffer> {
	const rowBytes = image.width * bytesPerPixel[image.format as Format];
	const paddedRowBytes = Math.ceil(rowBytes / 256) * 256; // WebGPU copy alignment
	const buffer = gpu.device.createBuffer({
		size: paddedRowBytes * image.height,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
	});
	const encoder = gpu.device.createCommandEncoder();
	encoder.copyTextureToBuffer({ texture: image }, { buffer, bytesPerRow: paddedRowBytes }, [
		image.width,
		image.height
	]);
	gpu.device.queue.submit([encoder.finish()]);
	await buffer.mapAsync(GPUMapMode.READ);
	const padded = new Uint8Array(buffer.getMappedRange());
	const packed = new Uint8Array(rowBytes * image.height);
	for (let row = 0; row < image.height; row++) {
		packed.set(
			padded.subarray(row * paddedRowBytes, row * paddedRowBytes + rowBytes),
			row * rowBytes
		);
	}
	buffer.destroy();
	return packed.buffer;
}
