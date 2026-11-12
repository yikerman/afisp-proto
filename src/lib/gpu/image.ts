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
	readonly bytes: number;
	readonly channels: 1 | 4;
	/** `texSubImage2D` format and type. */
	readonly format: GLenum;
	readonly type: GLenum;
	/** The packed array type over `channels` values per texel. */
	readonly packed: (length: number) => Pixels;
	/** `readPixels` type with format RGBA(_INTEGER), which every implementation accepts. */
	readonly readType: GLenum;
	readonly read: (length: number) => Read;
}

const layouts: Record<Format, Layout> = {
	R16UI: {
		internal: GL.R16UI,
		bytes: 2,
		channels: 1,
		format: GL.RED_INTEGER,
		type: GL.UNSIGNED_SHORT,
		packed: (n) => new Uint16Array(n),
		readType: GL.UNSIGNED_INT,
		read: (n) => new Uint32Array(n)
	},
	R32F: {
		internal: GL.R32F,
		bytes: 4,
		channels: 1,
		format: GL.RED,
		type: GL.FLOAT,
		packed: (n) => new Float32Array(n),
		readType: GL.FLOAT,
		read: (n) => new Float32Array(n)
	},
	RGBA16F: {
		internal: GL.RGBA16F,
		bytes: 8,
		channels: 4,
		format: GL.RGBA,
		type: GL.HALF_FLOAT,
		packed: (n) => new Float16Array(n),
		readType: GL.FLOAT,
		read: (n) => new Float32Array(n)
	},
	RGBA32F: {
		internal: GL.RGBA32F,
		bytes: 16,
		channels: 4,
		format: GL.RGBA,
		type: GL.FLOAT,
		packed: (n) => new Float32Array(n),
		readType: GL.FLOAT,
		read: (n) => new Float32Array(n)
	},
	RGBA8: {
		internal: GL.RGBA8,
		bytes: 4,
		channels: 4,
		format: GL.RGBA,
		type: GL.UNSIGNED_BYTE,
		packed: (n) => new Uint8Array(n),
		readType: GL.UNSIGNED_BYTE,
		read: (n) => new Uint8Array(n)
	}
};

/**
 * Released textures, for reuse. On ANGLE's OpenGL backend (Chromium on Linux) a new texture
 * is zero-filled at about 1.5 GB/s before its first use, whatever then writes it: a 42 MP
 * RGBA16F texture costs 220 ms to create against 4 ms to rewrite. Remove the pool when
 * creating a texture no longer costs more than writing it.
 */
interface Pool {
	/** By format and size, each list oldest first. */
	readonly free: Map<string, WebGLTexture[]>;
	/** Every pooled texture, oldest first. */
	readonly order: {
		readonly key: string;
		readonly texture: WebGLTexture;
		readonly bytes: number;
	}[];
	bytes: number;
}

// Bounds what released textures of sizes no longer in use (another file, another view) hold.
const POOL_BYTES = 2 ** 31;

const pools = new WeakMap<Gpu, Pool>();

function poolOf(gpu: Gpu): Pool {
	let pool = pools.get(gpu);
	if (!pool) pools.set(gpu, (pool = { free: new Map(), order: [], bytes: 0 }));
	return pool;
}

function allocate(gl: WebGL2RenderingContext, size: Size, format: Format): WebGLTexture {
	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texStorage2D(gl.TEXTURE_2D, 1, layouts[format].internal, size.width, size.height);
	// Integer and 32-bit float textures are incomplete, and read as 0, under a linear filter.
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	return texture;
}

/** A texture of undefined content; every pass and every upload writes all of it. */
export function createImage<E extends Encoding>(gpu: Gpu, size: Size, format: Format): Image<E> {
	const { gl } = gpu;
	const pool = poolOf(gpu);
	const key = `${format} ${size.width}x${size.height}`;
	const bytes = size.width * size.height * layouts[format].bytes;
	const reused = pool.free.get(key)?.pop();
	if (reused) {
		pool.order.splice(
			pool.order.findIndex((entry) => entry.texture === reused),
			1
		);
		pool.bytes -= bytes;
	}
	const texture = reused ?? allocate(gl, size, format);
	let released = false;
	const destroy = () => {
		// A texture released twice would be handed out to two images.
		if (released) throw new Error('A texture was destroyed twice.');
		released = true;
		pool.free.set(key, [...(pool.free.get(key) ?? []), texture]);
		pool.order.push({ key, texture, bytes });
		pool.bytes += bytes;
		while (pool.bytes > POOL_BYTES) {
			const oldest = pool.order.shift()!;
			const free = pool.free.get(oldest.key)!;
			free.splice(free.indexOf(oldest.texture), 1);
			pool.bytes -= oldest.bytes;
			gl.deleteTexture(oldest.texture);
		}
	};
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

// Bounds the pixel pack buffer: a full-size image read as RGBA float is several hundred MB.
const STRIP_BYTES = 64 << 20;

interface ReadPixels {
	readonly format: GLenum;
	readonly type: GLenum;
	/** Values per texel and bytes per value, as read. */
	readonly values: number;
	readonly bytes: number;
}

const nativeReads = new WeakMap<Gpu, Map<Format, boolean>>();

/**
 * The `readPixels` format and type for a texture of `format` attached to the framebuffer: its
 * own, when the implementation offers to return it as stored, which spares a conversion and up
 * to four times the transfer; otherwise RGBA at 32 (or 8) bits a value, which every
 * implementation accepts for the format's class (OpenGL ES 3.0.6, 4.3.2).
 */
function readPixelsOf(gpu: Gpu, format: Format): ReadPixels {
	const { gl } = gpu;
	const layout = layouts[format];
	let known = nativeReads.get(gpu);
	if (!known) nativeReads.set(gpu, (known = new Map()));
	let native = known.get(format);
	if (native === undefined) {
		native =
			// Workaround: ANGLE's OpenGL backend (Chromium 156) offers RED_INTEGER/UNSIGNED_SHORT
			// for R16UI and then loses the context reading it ("not handled by RGBA16 readPixels
			// workaround", FramebufferGL.cpp). Delete the exclusion when that read works.
			format !== 'R16UI' &&
			gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === layout.format &&
			gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === layout.type;
		known.set(format, native);
	}
	return native
		? {
				format: layout.format,
				type: layout.type,
				values: layout.channels,
				bytes: layout.bytes / layout.channels
			}
		: {
				format: format === 'R16UI' ? gl.RGBA_INTEGER : gl.RGBA,
				type: layout.readType,
				values: 4,
				bytes: layout.readType === gl.UNSIGNED_BYTE ? 1 : 4
			};
}

/** Tightly packed pixels of a region of the texture (all of it by default), in its format. */
export async function download(
	gpu: Gpu,
	image: Texture,
	region: Region = { x: 0, y: 0, width: image.width, height: image.height }
): Promise<ArrayBuffer> {
	const { gl, framebuffer } = gpu;
	const layout = layouts[image.format];
	const attach = () => {
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, image.texture, 0);
	};
	attach();
	const read = readPixelsOf(gpu, image.format);
	// Read as stored: no conversion.
	const native = read.values === layout.channels && read.type === layout.type;
	const rowBytes = region.width * read.values * read.bytes;
	const stripRows = Math.min(region.height, Math.max(1, Math.floor(STRIP_BYTES / rowBytes)));
	const pixelValues = region.width * layout.channels;
	const packed = layout.packed(pixelValues * region.height);
	const staging = layout.read(native ? 0 : stripRows * region.width * 4);
	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
	gl.bufferData(gl.PIXEL_PACK_BUFFER, stripRows * rowBytes, gl.STREAM_READ);
	for (let row = 0; row < region.height; row += stripRows) {
		const rows = Math.min(stripRows, region.height - row);
		attach();
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
		gl.readPixels(region.x, region.y + row, region.width, rows, read.format, read.type, 0);
		await finished(gl);
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
		const target = packed.subarray(row * pixelValues, (row + rows) * pixelValues);
		if (native) {
			const bytes = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
			gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, bytes);
		} else {
			const values = staging.subarray(0, rows * region.width * 4);
			gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, values);
			if (layout.channels === 4) target.set(values);
			else for (let i = 0; i < target.length; i++) target[i] = values[i * 4]!;
		}
	}
	gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
	gl.deleteBuffer(buffer);
	return packed.buffer as ArrayBuffer;
}
