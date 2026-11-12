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

/** Sized internal formats, by their OpenGL ES 3.0 names. */
export type Format = 'R16UI' | 'R32F' | 'RGBA16F' | 'RGBA32F' | 'RGBA8';

export interface Size {
	readonly width: number;
	readonly height: number;
}

/**
 * A texture of the GPU's context. Texel (x, y) is pixel x of row y, counted
 * in the order rows are uploaded and downloaded and as a pass's `p` counts them.
 */
export interface Texture extends Size {
	readonly format: Format;
	readonly texture: WebGLTexture;
	destroy(): void;
}

export type Image<E extends Encoding> = Texture & { readonly [encoding]: E };

/** Tightly packed pixels, as `upload` takes them and `download` returns them. */
type Pixels = Uint16Array | Float32Array | Float16Array | Uint8Array;
type Read = Uint32Array | Float32Array | Uint8Array;

const GL = WebGL2RenderingContext;

interface Layout {
	readonly internal: GLenum;
	readonly channels: 1 | 4;
	/** `texSubImage2D` format and type. */
	readonly format: GLenum;
	readonly type: GLenum;
	/** The packed array type over `channels` values per texel. */
	readonly packed: (length: number) => Pixels;
	/**
	 * `readPixels` type, with format RGBA(_INTEGER): the one combination every
	 * implementation accepts for the format's class (OpenGL ES 3.0.6, 4.3.2).
	 */
	readonly readType: GLenum;
	readonly read: (length: number) => Read;
}

const layouts: Record<Format, Layout> = {
	R16UI: {
		internal: GL.R16UI,
		channels: 1,
		format: GL.RED_INTEGER,
		type: GL.UNSIGNED_SHORT,
		packed: (n) => new Uint16Array(n),
		readType: GL.UNSIGNED_INT,
		read: (n) => new Uint32Array(n)
	},
	R32F: {
		internal: GL.R32F,
		channels: 1,
		format: GL.RED,
		type: GL.FLOAT,
		packed: (n) => new Float32Array(n),
		readType: GL.FLOAT,
		read: (n) => new Float32Array(n)
	},
	RGBA16F: {
		internal: GL.RGBA16F,
		channels: 4,
		format: GL.RGBA,
		type: GL.HALF_FLOAT,
		packed: (n) => new Float16Array(n),
		readType: GL.FLOAT,
		read: (n) => new Float32Array(n)
	},
	RGBA32F: {
		internal: GL.RGBA32F,
		channels: 4,
		format: GL.RGBA,
		type: GL.FLOAT,
		packed: (n) => new Float32Array(n),
		readType: GL.FLOAT,
		read: (n) => new Float32Array(n)
	},
	RGBA8: {
		internal: GL.RGBA8,
		channels: 4,
		format: GL.RGBA,
		type: GL.UNSIGNED_BYTE,
		packed: (n) => new Uint8Array(n),
		readType: GL.UNSIGNED_BYTE,
		read: (n) => new Uint8Array(n)
	}
};

/** A texture of undefined content; every pass and every upload writes all of it. */
export function createImage<E extends Encoding>(gpu: Gpu, size: Size, format: Format): Image<E> {
	const { gl } = gpu;
	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texStorage2D(gl.TEXTURE_2D, 1, layouts[format].internal, size.width, size.height);
	// Integer and 32-bit float textures are incomplete, and read as 0, under a linear filter.
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	const destroy = () => gl.deleteTexture(texture);
	return { width: size.width, height: size.height, format, texture, destroy } as Image<E>;
}

export function upload<E extends Encoding>(
	gpu: Gpu,
	size: Size,
	format: Format,
	pixels: Pixels
): Image<E> {
	const { gl } = gpu;
	const image = createImage<E>(gpu, size, format);
	const { format: f, type } = layouts[format];
	// WebGL takes half floats as their bit patterns.
	const data =
		pixels instanceof Float16Array
			? new Uint16Array(pixels.buffer, pixels.byteOffset, pixels.length)
			: pixels;
	gl.bindTexture(gl.TEXTURE_2D, image.texture);
	gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size.width, size.height, f, type, data);
	return image;
}

export interface Region extends Size {
	readonly x: number;
	readonly y: number;
}

/** Resolves once the GPU has executed every command issued so far, without blocking. */
async function finished(gl: WebGL2RenderingContext): Promise<void> {
	const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
	gl.flush();
	while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	gl.deleteSync(sync);
}

// Readback goes through RGBA at up to 4 bytes a channel, so a full-size image would need
// a staging buffer of several hundred MB; strips bound it.
const STRIP_BYTES = 64 << 20;

/** Tightly packed pixels of a region of the texture (all of it by default), in its format. */
export async function download(
	gpu: Gpu,
	image: Texture,
	region: Region = { x: 0, y: 0, width: image.width, height: image.height }
): Promise<ArrayBuffer> {
	const { gl, framebuffer } = gpu;
	const layout = layouts[image.format];
	const readFormat = image.format === 'R16UI' ? gl.RGBA_INTEGER : gl.RGBA;
	const rowValues = region.width * 4;
	const valueBytes = layout.readType === gl.UNSIGNED_BYTE ? 1 : 4;
	const stripRows = Math.min(
		region.height,
		Math.max(1, Math.floor(STRIP_BYTES / (rowValues * valueBytes)))
	);
	const pixelValues = region.width * layout.channels;
	const packed = layout.packed(pixelValues * region.height);
	const staging = layout.read(stripRows * rowValues);
	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
	gl.bufferData(gl.PIXEL_PACK_BUFFER, staging.byteLength, gl.STREAM_READ);
	for (let row = 0; row < region.height; row += stripRows) {
		const rows = Math.min(stripRows, region.height - row);
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, image.texture, 0);
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
		gl.readPixels(region.x, region.y + row, region.width, rows, readFormat, layout.readType, 0);
		await finished(gl);
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
		const read = staging.subarray(0, rows * rowValues);
		gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, read);
		const target = packed.subarray(row * pixelValues, (row + rows) * pixelValues);
		if (layout.channels === 4) target.set(read);
		else for (let i = 0; i < target.length; i++) target[i] = read[i * 4]!;
	}
	gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
	gl.deleteBuffer(buffer);
	return packed.buffer as ArrayBuffer;
}
