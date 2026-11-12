<script lang="ts">
	import type { EditState, Stage } from '../edit/controls';
	import { items, type Item } from '../edit/items';
	import type { Vec2 } from '../math/matrix';
	import Choice from './Choice.svelte';
	import Slider from './Slider.svelte';
	import Wheel from './Wheel.svelte';

	interface Props {
		stage: Stage;
		edit: EditState;
		initial: EditState;
		onchange: (item: string, value: unknown, change: Partial<EditState>) => void;
	}
	let { stage, edit, initial, onchange }: Props = $props();

	const shown = $derived(items.filter((item) => item.spec.stage === stage));
	const sections = $derived([...new Set(shown.map((item) => item.spec.section))]);
	const within = (section: string, advanced: boolean) =>
		shown.filter((item) => item.spec.section === section && item.spec.advanced === advanced);

	const set = (item: Item, value: unknown) =>
		onchange(item.id, value, item.write(value as never, edit, initial));
</script>

{#snippet widget(item: Item)}
	{@const spec = item.spec}
	{#if spec.widget === 'slider'}
		<Slider
			{spec}
			value={item.read(edit, initial) as number}
			initial={item.read(initial, initial) as number}
			onchange={(value) => set(item, value)}
		/>
	{:else if spec.widget === 'wheel'}
		<Wheel
			{spec}
			value={item.read(edit, initial) as Vec2}
			initial={item.read(initial, initial) as Vec2}
			onchange={(value) => set(item, value)}
		/>
	{:else}
		<Choice
			{spec}
			value={item.read(edit, initial) as string}
			onchange={(value) => set(item, value)}
		/>
	{/if}
{/snippet}

<!-- Sections follow the order the pipeline applies them in. -->
{#each sections as section (section)}
	<details class="section" open>
		<summary>{section}</summary>
		<div class="body">
			{#each within(section, false) as item (item.id)}{@render widget(item)}{/each}
			{#if within(section, true).length > 0}
				<details class="advanced">
					<summary>Advanced</summary>
					{#each within(section, true) as item (item.id)}{@render widget(item)}{/each}
				</details>
			{/if}
		</div>
	</details>
{/each}

<style>
	.section {
		border-bottom: 1px solid var(--edge);
	}
	summary {
		display: flex;
		align-items: center;
		gap: 6px;
		cursor: default;
		list-style: none;
	}
	summary::before {
		content: '';
		border: 4px solid transparent;
		border-left-color: var(--dim);
		border-right-width: 0;
	}
	details[open] > summary::before {
		transform: rotate(90deg);
	}
	.section > summary {
		height: 26px;
		padding: 0 10px;
		font-weight: 600;
		background: var(--field);
	}
	.section > summary:hover,
	.advanced > summary:hover {
		color: var(--bright);
	}
	.body {
		padding: 6px 10px 8px;
	}
	.advanced > summary {
		height: var(--row);
		color: var(--dim);
	}
</style>
