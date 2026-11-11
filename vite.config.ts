import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// The app is client-only (WebGPU); it ships as static files with one entry page.
			adapter: adapter({ fallback: 'index.html' })
		})
	],
	test: {
		include: ['src/**/*.test.ts'],
		// Shader tests need WebGPU, so every test runs in a real browser.
		// CHROMIUM selects a system browser instead of Playwright's download.
		browser: {
			enabled: true,
			headless: true,
			screenshotFailures: false,
			provider: playwright({
				launchOptions: {
					...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
					args: ['--enable-unsafe-webgpu']
				}
			}),
			instances: [{ browser: 'chromium' }]
		}
	}
});
