import type { Gpu } from './gpu';
import { createImage, type Encoding, type Format, type Image, type Size } from './image';
import { pack, structDeclaration, type Uniforms } from './uniforms';

/**
 * One image-to-image step: a pure function of its textures and uniforms,
 * evaluated independently at every output pixel.
 *
 * `wgsl` must define `fn pixel(p: vec2i) -> vec4f`. It sees each texture under
 * its key in `textures` and the uniforms as the fields of `u`. It can read
 * nothing else, which is what lets a caller restrict a module's inputs by
 * choosing what to bind.
 */
export interface Pass {
	readonly label: string;
	readonly wgsl: string;
	readonly textures: Readonly<Record<string, GPUTexture>>;
	readonly uniforms: Uniforms;
	readonly size: Size;
	readonly format: Format;
}

const sampleType = (texture: GPUTexture): 'uint' | 'unfilterable-float' =>
	texture.format.endsWith('uint') ? 'uint' : 'unfilterable-float';

function shaderSource(pass: Pass): string {
	const hasUniforms = Object.keys(pass.uniforms).length > 0;
	const textures = Object.entries(pass.textures).map(
		([name, texture], i) =>
			`@group(0) @binding(${i + 1}) var ${name}: texture_2d<${sampleType(texture) === 'uint' ? 'u32' : 'f32'}>;`
	);
	return `
${hasUniforms ? `${structDeclaration('Uniforms', pass.uniforms)}\n@group(0) @binding(0) var<uniform> u: Uniforms;` : ''}
${textures.join('\n')}

${pass.wgsl}

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	// One triangle covering the viewport.
	return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0, 1);
}

@fragment
fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
	return pixel(vec2i(position.xy));
}
`;
}

interface Compiled {
	readonly pipeline: GPURenderPipeline;
	readonly layout: GPUBindGroupLayout;
}

// Compilation is a pure function of the source and output format, so it is memoised on them.
const compiled = new WeakMap<GPUDevice, Map<string, Compiled>>();

function compile(gpu: Gpu, pass: Pass): Compiled {
	let cache = compiled.get(gpu.device);
	if (!cache) compiled.set(gpu.device, (cache = new Map()));
	const code = shaderSource(pass);
	const key = `${pass.format}\n${code}`;
	let entry = cache.get(key);
	if (!entry) {
		const entries: GPUBindGroupLayoutEntry[] = Object.values(pass.textures).map((texture, i) => ({
			binding: i + 1,
			visibility: GPUShaderStage.FRAGMENT,
			texture: { sampleType: sampleType(texture) }
		}));
		if (Object.keys(pass.uniforms).length > 0) {
			entries.push({ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} });
		}
		const layout = gpu.device.createBindGroupLayout({ label: pass.label, entries });
		const module = gpu.device.createShaderModule({ label: pass.label, code });
		const pipeline = gpu.device.createRenderPipeline({
			label: pass.label,
			layout: gpu.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
			vertex: { module },
			fragment: { module, targets: [{ format: pass.format }] }
		});
		cache.set(key, (entry = { pipeline, layout }));
	}
	return entry;
}

/** Runs the pass into `target`, which may be a canvas texture. */
export function runInto(gpu: Gpu, pass: Pass, target: GPUTexture): void {
	const { pipeline, layout } = compile(gpu, pass);
	const entries: GPUBindGroupEntry[] = Object.values(pass.textures).map((texture, i) => ({
		binding: i + 1,
		resource: texture.createView()
	}));
	const data = pack(pass.uniforms);
	let buffer: GPUBuffer | undefined;
	if (data.length > 0) {
		buffer = gpu.device.createBuffer({
			size: data.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		gpu.device.queue.writeBuffer(buffer, 0, data);
		entries.push({ binding: 0, resource: { buffer } });
	}
	const encoder = gpu.device.createCommandEncoder({ label: pass.label });
	const render = encoder.beginRenderPass({
		colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }]
	});
	render.setPipeline(pipeline);
	render.setBindGroup(0, gpu.device.createBindGroup({ layout, entries }));
	render.draw(3);
	render.end();
	gpu.device.queue.submit([encoder.finish()]);
	buffer?.destroy();
}

export function run<E extends Encoding>(gpu: Gpu, pass: Pass): Image<E> {
	const image = createImage<E>(gpu, pass.label, pass.size, pass.format);
	runInto(gpu, pass, image);
	return image;
}
