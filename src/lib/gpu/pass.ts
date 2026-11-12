import type { Gpu } from './gpu';
import {
	createImage,
	type Encoding,
	type Format,
	type Image,
	type Size,
	type Texture
} from './image';
import { setUniform, structDeclaration, type Uniforms } from './uniforms';

/**
 * One image-to-image step: a pure function of its textures and uniforms,
 * evaluated independently at every output pixel.
 *
 * `glsl` is GLSL ES 3.00 and must define `vec4 pixel(ivec2 p)`. It sees each
 * texture under its key in `textures` (a `usampler2D` for integer formats, a
 * `sampler2D` otherwise, read with `texelFetch`) and the uniforms as the
 * members of `u`. It can read nothing else, which is what lets a caller
 * restrict a module's inputs by choosing what to bind.
 */
export interface Pass {
	readonly label: string;
	readonly glsl: string;
	readonly textures: Readonly<Record<string, Texture>>;
	readonly uniforms: Uniforms;
	readonly size: Size;
	readonly format: Format;
}

const vertexSource = `#version 300 es
void main() {
	// One triangle covering the viewport.
	gl_Position = vec4(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID >> 1) * 4 - 1), 0, 1);
}`;

function fragmentSource(pass: Pass): string {
	const hasUniforms = Object.keys(pass.uniforms).length > 0;
	const samplers = Object.entries(pass.textures).map(
		([name, texture]) =>
			`uniform ${texture.format === 'R16UI' ? 'usampler2D' : 'sampler2D'} ${name};`
	);
	// gl_FragCoord is at pixel centres, so its integer part is the pixel's index.
	return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
${hasUniforms ? `${structDeclaration('Uniforms', pass.uniforms)}\nuniform Uniforms u;` : ''}
${samplers.join('\n')}

${pass.glsl}

out vec4 pass_output;
void main() {
	pass_output = pixel(ivec2(gl_FragCoord.xy));
}
`;
}

interface Program {
	readonly program: WebGLProgram;
	readonly locations: Readonly<Record<string, WebGLUniformLocation | null>>;
}

function shader(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
	const shader = gl.createShader(type)!;
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	return shader;
}

// Compilation is a pure function of the source, so it is memoised on it. The output
// format does not enter: every format a pass writes takes a vec4.
const compiled = new WeakMap<Gpu, Map<string, Program>>();

function compile(gpu: Gpu, pass: Pass): Program {
	const { gl } = gpu;
	let cache = compiled.get(gpu);
	if (!cache) compiled.set(gpu, (cache = new Map()));
	const source = fragmentSource(pass);
	let entry = cache.get(source);
	if (!entry) {
		const program = gl.createProgram();
		const vertex = shader(gl, gl.VERTEX_SHADER, vertexSource);
		const fragment = shader(gl, gl.FRAGMENT_SHADER, source);
		gl.attachShader(program, vertex);
		gl.attachShader(program, fragment);
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			throw new Error(
				`${pass.label}: ${gl.getShaderInfoLog(fragment) || gl.getProgramInfoLog(program)}`
			);
		}
		gl.deleteShader(vertex);
		gl.deleteShader(fragment);
		const names = [
			...Object.keys(pass.textures),
			...Object.keys(pass.uniforms).map((name) => `u.${name}`)
		];
		const locations = Object.fromEntries(
			names.map((name) => [name, gl.getUniformLocation(program, name)])
		);
		cache.set(source, (entry = { program, locations }));
	}
	return entry;
}

/** Runs the pass into `target`, which has the pass's size and format. */
function runInto(gpu: Gpu, pass: Pass, target: Texture): void {
	const { gl, framebuffer } = gpu;
	const { program, locations } = compile(gpu, pass);
	gl.useProgram(program);
	Object.entries(pass.textures).forEach(([name, texture], unit) => {
		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(gl.TEXTURE_2D, texture.texture);
		gl.uniform1i(locations[name], unit);
	});
	for (const [name, uniform] of Object.entries(pass.uniforms)) {
		setUniform(gl, locations[`u.${name}`], uniform);
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
	gl.viewport(0, 0, pass.size.width, pass.size.height);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
}

export function run<E extends Encoding>(gpu: Gpu, pass: Pass): Image<E> {
	const image = createImage<E>(gpu, pass.size, pass.format);
	runInto(gpu, pass, image);
	return image;
}

/**
 * The pass's output as a bitmap for an `ImageBitmapRenderingContext`, pixel
 * for pixel, transparent where the pass writes alpha 0.
 *
 * A bitmap is the one way a frame leaves the GPU's OffscreenCanvas without a
 * copy through the CPU. The canvas's drawing buffer has its first row at the
 * bottom of the picture, unlike textures here, so the copy into it flips rows.
 */
export function present(gpu: Gpu, pass: Pass & { readonly format: 'RGBA8' }): ImageBitmap {
	const { gl, canvas, framebuffer } = gpu;
	const { width, height } = pass.size;
	const frame = run<never>(gpu, pass);
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
	gl.framebufferTexture2D(
		gl.READ_FRAMEBUFFER,
		gl.COLOR_ATTACHMENT0,
		gl.TEXTURE_2D,
		frame.texture,
		0
	);
	gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
	gl.blitFramebuffer(0, 0, width, height, 0, height, width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	frame.destroy();
	return canvas.transferToImageBitmap();
}
