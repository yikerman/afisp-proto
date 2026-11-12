<script lang="ts">
	import { onMount } from 'svelte';
	import { withStageReset } from '#lib/edit/controls.js';
	import { toEdit } from '#lib/edit/edit.js';
	import { Session, type Screen } from '#lib/edit/session.svelte.js';
	import { exportTiff } from '#lib/export/export.js';
	import { acquireGpu, type Gpu } from '#lib/gpu/gpu.js';
	import { createRenderer, type Renderer } from '#lib/pipeline/render.js';
	import { imageSize } from '#lib/pipeline/restoration/calibrate.js';
	import { decode, type RawMeta } from '#lib/raw/decode.js';
	import HistogramView from '#lib/ui/Histogram.svelte';
	import Panel from '#lib/ui/Panel.svelte';
	import Viewer from '#lib/ui/Viewer.svelte';
	import type { Histogram } from '#lib/view/histogram.js';

	const session = new Session();
	const screens: readonly (readonly [Screen, string])[] = [
		['select', 'File'],
		['restoration', 'Restoration'],
		['adjustments', 'Adjustments'],
		['export', 'Export']
	];

	let gpu = $state.raw<Gpu | null>(null);
	let renderer = $state.raw<Renderer | null>(null);
	let histogram = $state.raw<Histogram | null>(null);
	let failure = $state<string | null>(null);
	let busy = $state(false);

	// Each screen shows the pipeline up to its own stage.
	const shown = $derived(
		session.file && session.screen === 'restoration'
			? withStageReset(session.edit, session.file.initial, 'adjustments')
			: session.edit
	);
	const next = $derived(screens[screens.findIndex(([screen]) => screen === session.screen) + 1]);

	const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

	onMount(() => {
		acquireGpu().then(
			(acquired) => (gpu = acquired),
			(error) => (failure = message(error))
		);
	});

	async function open(file: File) {
		busy = true;
		failure = null;
		try {
			const raw = await decode(await file.arrayBuffer());
			renderer?.destroy();
			renderer = createRenderer(gpu!, raw);
			session.open(file.name, raw);
		} catch (error) {
			failure = message(error);
		}
		busy = false;
	}

	function save(blob: Blob, name: string) {
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = name;
		link.click();
		// The browser reads the blob after this returns; revoking at once can cancel a large download.
		setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
	}

	const baseName = () => session.file!.name.replace(/\.[^.]+$/, '');

	async function exportImage() {
		busy = true;
		save(await exportTiff(gpu!, renderer!.render(toEdit(session.edit))), `${baseName()}.tif`);
		busy = false;
	}

	const saveLog = () =>
		save(
			new Blob([JSON.stringify(session.log)], { type: 'application/json' }),
			`${baseName()}.log.json`
		);

	const facts = (meta: RawMeta): readonly (readonly [string, string])[] => [
		['Camera', meta.camera],
		['Lens', meta.lens],
		['Focal length', `${Number(meta.focalLength.toFixed(1))} mm`],
		['Aperture', `f/${Number(meta.aperture.toFixed(1))}`],
		['Shutter', meta.shutter < 1 ? `1/${Math.round(1 / meta.shutter)} s` : `${meta.shutter} s`],
		['ISO', `${meta.iso}`],
		['Size', `${imageSize(meta).width} × ${imageSize(meta).height}`]
	];
</script>

<div class="app">
	<main>
		{#if session.screen === 'select' || !session.file || !renderer || !gpu}
			<div class="select">
				<label class="open">
					<input
						type="file"
						disabled={!gpu || busy}
						onchange={(event) => {
							const file = event.currentTarget.files?.[0];
							if (file) void open(file);
						}}
					/>
					{busy ? 'Opening' : 'Open RAW file'}
				</label>
				{#if failure}<p class="failure">{failure}</p>{/if}
				{#if session.file}
					<table>
						<tbody>
							<tr><th>File</th><td>{session.file.name}</td></tr>
							{#each facts(session.file.raw.meta) as [name, value] (name)}
								<tr><th>{name}</th><td>{value}</td></tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		{:else}
			<Viewer
				{gpu}
				{renderer}
				edit={toEdit(shown)}
				image={imageSize(session.file.raw.meta)}
				onhistogram={(counts) => (histogram = counts)}
			/>
			<aside>
				<div class="scope"><HistogramView {histogram} /></div>
				{#if session.screen === 'export'}
					<section>
						<table>
							<tbody>
								<tr><th>Format</th><td>TIFF, 16 bit</td></tr>
								<tr><th>Colour space</th><td>sRGB</td></tr>
								<tr>
									<th>Size</th>
									<td>
										{imageSize(session.file.raw.meta).width} × {imageSize(session.file.raw.meta)
											.height}
									</td>
								</tr>
							</tbody>
						</table>
						<div class="actions">
							<button disabled={busy} onclick={exportImage}>{busy ? 'Exporting' : 'Export'}</button>
							<button onclick={saveLog}>Save session log</button>
						</div>
					</section>
				{:else}
					{#key session.screen}
						<Panel
							stage={session.screen}
							edit={session.edit}
							initial={session.file.initial}
							onchange={(control, value) => session.set(control, value)}
						/>
					{/key}
				{/if}
			</aside>
		{/if}
	</main>

	<nav>
		{#each screens as [screen, label] (screen)}
			<button
				aria-current={session.screen === screen}
				disabled={!session.file}
				onclick={() => session.go(screen)}
			>
				{label}
			</button>
		{/each}
		<button class="next" disabled={!session.file || !next} onclick={() => session.go(next[0])}>
			Next
		</button>
	</nav>
</div>

<style>
	.app {
		display: grid;
		grid-template-rows: 1fr 32px;
		height: 100%;
	}
	main {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		grid-template-rows: minmax(0, 1fr);
		min-height: 0;
	}
	aside {
		background: var(--panel);
		border-left: 1px solid var(--edge);
		overflow-y: auto;
	}
	.scope {
		padding: 10px;
		border-bottom: 1px solid var(--edge);
	}
	section {
		padding: 10px;
	}
	.select {
		grid-column: 1 / -1;
		place-self: center;
		display: grid;
		gap: 12px;
		min-width: 320px;
	}
	.open {
		display: grid;
		place-items: center;
		height: 28px;
		background: var(--field);
		border: 1px solid var(--edge);
		border-radius: 2px;
	}
	.open:hover {
		color: var(--bright);
	}
	.open input {
		display: none;
	}
	.failure {
		margin: 0;
		color: var(--bright);
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th {
		width: 96px;
		padding: 2px 0;
		text-align: left;
		font-weight: normal;
		color: var(--dim);
	}
	td {
		user-select: text;
	}
	.actions {
		display: flex;
		gap: 6px;
		margin-top: 10px;
	}
	nav {
		display: flex;
		justify-content: center;
		align-items: stretch;
		background: var(--panel);
		border-top: 1px solid var(--edge);
	}
	nav button {
		height: auto;
		min-width: 110px;
		background: none;
		border: none;
		border-top: 2px solid transparent;
		border-radius: 0;
		color: var(--dim);
	}
	nav button[aria-current='true'] {
		color: var(--bright);
		border-top-color: var(--bright);
	}
	nav .next {
		position: absolute;
		right: 0;
		min-width: 70px;
		height: 30px;
	}
</style>
