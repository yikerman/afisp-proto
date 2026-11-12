import { expect, test } from 'vitest';
import { acquireGpu } from './gpu';
import { download, upload } from './image';
import { run } from './pass';
import { f32, mat3x3f, vec2f, vec3f } from './uniforms';

test('a pass reads its textures and uniforms at each pixel', async () => {
	const gpu = await acquireGpu('accept');
	const size = { width: 3, height: 2 };
	const source = upload(gpu, 'source', size, 'r32float', new Float32Array([0, 1, 2, 3, 4, 5]));
	const counts = upload(gpu, 'counts', size, 'r16uint', new Uint16Array([10, 20, 30, 40, 50, 60]));

	const result = run(gpu, {
		label: 'test',
		wgsl: `
			fn pixel(p: vec2i) -> vec4f {
				let v = textureLoad(source, p, 0).r + f32(textureLoad(counts, p, 0).r);
				// Exercises every uniform type and the padding between them.
				return vec4f(v * u.gain + u.offset.y, (u.matrix * u.vector).xy, u.last);
			}`,
		textures: { source, counts },
		uniforms: {
			gain: f32(2),
			offset: vec2f([100, 0.5]),
			vector: vec3f([1, 2, 3]),
			matrix: mat3x3f([1, 0, 0, 0, 10, 0, 0, 0, 100]),
			last: f32(7)
		},
		size,
		format: 'rgba16float'
	});

	const pixels = new Float16Array(await download(gpu, result));
	expect(Array.from(pixels.filter((_, i) => i % 4 === 0))).toEqual([
		20.5, 42.5, 64.5, 86.5, 108.5, 130.5
	]);
	expect(Array.from(pixels.slice(1, 4))).toEqual([1, 20, 7]);
});
