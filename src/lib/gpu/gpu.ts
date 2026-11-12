export interface Gpu {
	readonly device: GPUDevice;
}

/**
 * Boundary to the platform: the only place that deals with WebGPU being absent
 * or emulated. A software adapter computes correctly but takes seconds per
 * frame at full resolution and stalls the browser, so only tests accept one.
 */
export async function acquireGpu(software: 'refuse' | 'accept' = 'refuse'): Promise<Gpu> {
	const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
	if (!adapter) throw new Error('WebGPU is not available in this browser.');
	if (adapter.info.isFallbackAdapter && software === 'refuse') {
		throw new Error(
			'WebGPU is running in software: the browser could not reach the graphics card.'
		);
	}
	const device = await adapter.requestDevice({
		// Full-resolution processing: a sensor's long side must fit in one texture,
		// and a whole image in one buffer when it is read back for export.
		requiredLimits: {
			maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
			maxBufferSize: adapter.limits.maxBufferSize
		}
	});
	// Validation and out-of-memory errors are otherwise silent: the frame just stays black.
	device.addEventListener('uncapturederror', (event) => console.error(event.error.message));
	void device.lost.then((lost) => console.error(`GPU device lost: ${lost.message}`));
	return { device };
}
