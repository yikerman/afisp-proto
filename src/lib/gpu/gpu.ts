export interface Gpu {
	readonly device: GPUDevice;
}

/** Boundary to the platform: the only place that deals with WebGPU being absent. */
export async function acquireGpu(): Promise<Gpu> {
	const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
	if (!adapter) throw new Error('WebGPU is not available in this browser.');
	const device = await adapter.requestDevice({
		// Full-resolution processing: a sensor's long side must fit in one texture.
		requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D }
	});
	// Validation and out-of-memory errors are otherwise silent: the frame just stays black.
	device.addEventListener('uncapturederror', (event) => console.error(event.error.message));
	void device.lost.then((lost) => console.error(`GPU device lost: ${lost.message}`));
	return { device };
}
