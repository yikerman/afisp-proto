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

export interface Region extends Size {
	readonly x: number;
	readonly y: number;
}

/** Tightly packed bytes of a region of the texture (all of it by default), row padding removed. */
export async function download(
	gpu: Gpu,
	image: GPUTexture,
	region: Region = { x: 0, y: 0, width: image.width, height: image.height }
): Promise<ArrayBuffer> {
	const rowBytes = region.width * bytesPerPixel[image.format as Format];
	const paddedRowBytes = Math.ceil(rowBytes / 256) * 256; // WebGPU copy alignment
	const buffer = gpu.device.createBuffer({
		size: paddedRowBytes * region.height,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
	});
	const encoder = gpu.device.createCommandEncoder();
	encoder.copyTextureToBuffer(
		{ texture: image, origin: [region.x, region.y] },
		{ buffer, bytesPerRow: paddedRowBytes },
		[region.width, region.height]
	);
	gpu.device.queue.submit([encoder.finish()]);
	await buffer.mapAsync(GPUMapMode.READ);
	const padded = new Uint8Array(buffer.getMappedRange());
	const packed = new Uint8Array(rowBytes * region.height);
	for (let row = 0; row < region.height; row++) {
		packed.set(
			padded.subarray(row * paddedRowBytes, row * paddedRowBytes + rowBytes),
			row * rowBytes
		);
	}
	buffer.destroy();
	return packed.buffer;
}
