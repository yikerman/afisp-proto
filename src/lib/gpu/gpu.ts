/**
 * The WebGL 2 context everything runs on. It lives on an OffscreenCanvas
 * because textures belong to the context that made them and must outlive any
 * one viewer; `present` hands frames from it to the page.
 */
export interface Gpu {
	readonly gl: WebGL2RenderingContext;
	readonly canvas: OffscreenCanvas;
	/** Attaches the texture a pass writes or a readback reads. */
	readonly framebuffer: WebGLFramebuffer;
}

/** The device the context runs on, as the driver names it where the browser tells. */
export function renderer(gl: WebGL2RenderingContext): string {
	const info = gl.getExtension('WEBGL_debug_renderer_info');
	return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
}

// Software rasterisers: SwiftShader (Chromium), llvmpipe and softpipe (Mesa), WARP (Windows),
// Apple's software renderer. `failIfMajorPerformanceCaveat` is no substitute: headless
// Chromium 156 grants it on SwiftShader.
const SOFTWARE = /SwiftShader|llvmpipe|softpipe|Basic Render Driver|Apple Software Renderer/i;

/**
 * Boundary to the platform: the only place that deals with WebGL 2 being
 * absent, incomplete or emulated. A software renderer computes correctly but
 * takes seconds per frame at full resolution and stalls the browser, so only
 * tests accept one.
 */
export async function acquireGpu(software: 'refuse' | 'accept' = 'refuse'): Promise<Gpu> {
	const canvas = new OffscreenCanvas(1, 1);
	const gl = canvas.getContext('webgl2', {
		powerPreference: 'high-performance',
		antialias: false,
		depth: false,
		stencil: false
	});
	if (!gl) throw new Error('WebGL 2 is not available in this browser.');
	if (software === 'refuse' && SOFTWARE.test(renderer(gl))) {
		throw new Error(
			`WebGL 2 is running in software (${renderer(gl)}): the browser could not reach the graphics card.`
		);
	}
	if (!gl.getExtension('EXT_color_buffer_float')) {
		throw new Error('WebGL 2 cannot render to float textures here (no EXT_color_buffer_float).');
	}
	canvas.addEventListener('webglcontextlost', () => console.error('GPU context lost.'));
	// Rows are tightly packed in both directions, whatever their length in bytes.
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
	return { gl, canvas, framebuffer: gl.createFramebuffer() };
}
