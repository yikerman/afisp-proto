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
	return { device };
}
