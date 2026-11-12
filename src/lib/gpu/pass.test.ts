import { beforeAll, expect, test } from 'vitest';
import { glslMatrix, transform, columnMajor, type Matrix3 } from '../math/matrix';
import { acquireGpu, renderer, type Gpu } from './gpu';
import { download, upload, type Format, type Size } from './image';
import { present, run } from './pass';
import { float, floats, mat3, vec2, vec3, vec4 } from './uniforms';

let gpu: Gpu;
beforeAll(async () => {
	gpu = await acquireGpu('accept');
});

test('a pass reads its textures and uniforms at each pixel', async () => {
	const size = { width: 3, height: 2 };
	const source = upload(gpu, size, 'R32F', new Float32Array([0, 1, 2, 3, 4, 5]));
	const counts = upload(gpu, size, 'R16UI', new Uint16Array([10, 20, 30, 40, 50, 60]));

	const result = run(gpu, {
		label: 'test',
		glsl: `
			vec4 pixel(ivec2 p) {
				float v = texelFetch(source, p, 0).r + float(texelFetch(counts, p, 0).r);
				// Exercises every uniform type.
				return vec4(v * u.gain + u.offset.y, (u.matrix * u.vector).xy, u.last + u.list[2] + u.four.w);
			}`,
		textures: { source, counts },
		uniforms: {
			gain: float(2),
			offset: vec2([100, 0.5]),
			vector: vec3([1, 2, 3]),
			matrix: mat3([1, 0, 0, 0, 10, 0, 0, 0, 100]),
			last: float(7),
			list: floats([0, 0, 1000]),
			four: vec4([0, 0, 0, 0.5])
		},
		size,
		format: 'RGBA16F'
	});

	const pixels = new Float16Array(await download(gpu, result));
	expect(Array.from(pixels.filter((_, i) => i % 4 === 0))).toEqual([
		20.5, 42.5, 64.5, 86.5, 108.5, 130.5
	]);
	expect(Array.from(pixels.slice(1, 4))).toEqual([1, 20, 1007.5]);
});

test('a matrix means the same as a uniform, as a constant and in TypeScript', async () => {
	// Not symmetric, so a transpose anywhere changes the result.
	const m: Matrix3 = [
		[1, 2, 3],
		[4, 5, 6],
		[7, 8, 10]
	];
	const v = [0.5, -1, 2] as const;
	const result = run(gpu, {
		label: 'matrix',
		glsl: `
			vec4 pixel(ivec2 p) {
				vec3 v = p.x == 0 ? u.matrix * u.v : ${glslMatrix(m)} * u.v;
				return vec4(v, 1);
			}`,
		textures: {},
		uniforms: { matrix: mat3(columnMajor(m)), v: vec3(v) },
		size: { width: 2, height: 1 },
		format: 'RGBA32F'
	});
	const pixels = new Float32Array(await download(gpu, result));
	const expected = [...transform(m, v), 1];
	expect(Array.from(pixels.slice(0, 4))).toEqual(expected);
	expect(Array.from(pixels.slice(4, 8))).toEqual(expected);
});

// Rows and columns all differ, so a flip or a transpose shows.
const asymmetric = { width: 4, height: 3 };
const value = (x: number, y: number, c: number) => 1 + x + 10 * y + 100 * c;
function pixels(channels: number, scale = 1): number[] {
	const out: number[] = [];
	for (let y = 0; y < asymmetric.height; y++) {
		for (let x = 0; x < asymmetric.width; x++) {
			for (let c = 0; c < channels; c++) out.push(value(x, y, c) * scale);
		}
	}
	return out;
}

const roundTrips: readonly (readonly [
	Format,
	() => Uint16Array | Float32Array | Float16Array | Uint8Array
])[] = [
	['R16UI', () => new Uint16Array(pixels(1, 100))],
	['R32F', () => new Float32Array(pixels(1, 1 / 3))],
	['RGBA16F', () => new Float16Array(pixels(4, 1 / 3))],
	['RGBA32F', () => new Float32Array(pixels(4, 1 / 3))],
	['RGBA8', () => new Uint8Array(pixels(4).map((v) => v % 256))]
];

for (const [format, data] of roundTrips) {
	test(`${format} round trip: download returns what upload took, row by row`, async () => {
		const sent = data();
		const image = upload(gpu, asymmetric, format, sent);
		const received = new (sent.constructor as new (buffer: ArrayBuffer) => typeof sent)(
			await download(gpu, image)
		);
		expect(Array.from(received)).toEqual(Array.from(sent));
		image.destroy();
	});
}

test('every renderable format holds what a pass writes, rounded to its precision', async () => {
	const third = 1 / 3;
	const write = (format: Format) =>
		run(gpu, {
			label: 'write',
			glsl: `
				vec4 pixel(ivec2 p) {
					// One rounding per value: the integers are exact.
					return (float(1 + p.x + 10 * p.y) + vec4(0, 100, 200, 300)) * u.scale;
				}`,
			textures: {},
			uniforms: { scale: float(third) },
			size: asymmetric,
			format
		});
	const exact = pixels(4, Math.fround(third));
	const f32 = new Float32Array(await download(gpu, write('RGBA32F')));
	expect(Array.from(f32)).toEqual(Array.from(new Float32Array(exact)));
	const r32 = new Float32Array(await download(gpu, write('R32F')));
	expect(Array.from(r32)).toEqual(Array.from(new Float32Array(pixels(1, Math.fround(third)))));
	// Half floats come from the float32 result rounded to nearest or toward zero: the rounding
	// of a render target write is the driver's. SwiftShader rounds to nearest; NVIDIA's OpenGL
	// and Vulkan drivers both truncate (RTX 3080, measured).
	const f16 = new Float16Array(await download(gpu, write('RGBA16F')));
	const towardZero = (v: number) => {
		const half = new Float16Array([v]);
		// Halves are sign and magnitude: one less in the bits is the next smaller magnitude.
		const bits = new Uint16Array(half.buffer);
		if (Math.abs(half[0]!) > Math.abs(v)) bits[0] = bits[0]! - 1;
		return half[0]!;
	};
	f16.forEach((value, i) => {
		expect([Math.f16round(f32[i]!), towardZero(f32[i]!)]).toContain(value);
	});
	const unorm = new Uint8Array(
		await download(
			gpu,
			run(gpu, {
				label: 'unorm',
				glsl: 'vec4 pixel(ivec2 p) { return vec4(float(p.x) / 255.0, float(p.y) / 255.0, 0.5, 1); }',
				textures: {},
				uniforms: {},
				size: asymmetric,
				format: 'RGBA8'
			})
		)
	);
	expect(Array.from(unorm.slice(4 * 6, 4 * 7))).toEqual([2, 1, 128, 255]);
});

test('pixel (x, y) a pass writes is pixel (x, y) the next pass reads and row y downloaded', async () => {
	const source = upload(gpu, asymmetric, 'R32F', new Float32Array(pixels(1)));
	// Each pass reads its right-hand neighbour, so two passes shift by two columns.
	const shift = (image: typeof source) =>
		run<never>(gpu, {
			label: 'shift',
			glsl: `
				vec4 pixel(ivec2 p) {
					return vec4(texelFetch(image, min(p + ivec2(1, 0), textureSize(image, 0) - 1), 0).r, p, 1);
				}`,
			textures: { image },
			uniforms: {},
			size: asymmetric,
			format: 'RGBA32F'
		});
	const once = shift(source);
	const twice = new Float32Array(await download(gpu, shift(once)));
	for (let y = 0; y < asymmetric.height; y++) {
		for (let x = 0; x < asymmetric.width; x++) {
			const i = 4 * (y * asymmetric.width + x);
			expect(Array.from(twice.slice(i, i + 4))).toEqual([
				value(Math.min(x + 2, asymmetric.width - 1), y, 0),
				x,
				y,
				1
			]);
		}
	}
});

test('a region downloads the texels at its offset', async () => {
	const image = upload(gpu, asymmetric, 'RGBA16F', new Float16Array(pixels(4)));
	const region = { x: 1, y: 1, width: 2, height: 2 };
	const got = new Float16Array(await download(gpu, image, region));
	const expected: number[] = [];
	for (let y = 1; y < 3; y++) {
		for (let x = 1; x < 3; x++) for (let c = 0; c < 4; c++) expected.push(value(x, y, c));
	}
	expect(Array.from(got)).toEqual(expected);
});

test('a presented frame is upright, pixel for pixel, and transparent where alpha is 0', async () => {
	const size: Size = { width: 5, height: 3 };
	const bitmap = present(gpu, {
		label: 'present',
		glsl: `
			vec4 pixel(ivec2 p) {
				return p.x == 4 ? vec4(0) : vec4(float(p.x) * 50.0 / 255.0, float(p.y) * 100.0 / 255.0, 1, 1);
			}`,
		textures: {},
		uniforms: {},
		size,
		format: 'RGBA8'
	});
	expect([bitmap.width, bitmap.height]).toEqual([5, 3]);
	const canvas = new OffscreenCanvas(size.width, size.height);
	const context = canvas.getContext('2d')!;
	context.drawImage(bitmap, 0, 0);
	const { data } = context.getImageData(0, 0, size.width, size.height);
	for (let y = 0; y < size.height; y++) {
		for (let x = 0; x < size.width; x++) {
			const i = 4 * (y * size.width + x);
			expect(Array.from(data.slice(i, i + 4))).toEqual(
				x === 4 ? [0, 0, 0, 0] : [x * 50, y * 100, 255, 255]
			);
		}
	}
});

test('acquisition refuses a software renderer and accepts it only when asked', async () => {
	const software = /SwiftShader|llvmpipe/i.test(renderer(gpu.gl));
	const refused = await acquireGpu('refuse').then(
		() => false,
		() => true
	);
	expect(refused).toBe(software);
});
