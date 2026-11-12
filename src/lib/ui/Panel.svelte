<script lang="ts">
	import {
		controlIds,
		controls,
		type ControlId,
		type EditState,
		type Stage
	} from '../edit/controls';
	import Slider from './Slider.svelte';
	import Wheel from './Wheel.svelte';

	interface Props {
		stage: Stage;
		edit: EditState;
		initial: EditState;
		onchange: <K extends ControlId>(control: K, value: EditState[K]) => void;
	}
	let { stage, edit, initial, onchange }: Props = $props();

	const ids = $derived(controlIds.filter((id) => controls[id].stage === stage));
	const sections = $derived([...new Set(ids.map((id) => controls[id].section))]);
	// Adjustments are grouped the way the pipeline runs them, one group at a time.
	const tabbed = $derived(stage === 'adjustments');
	let chosen = $state<string | null>(null);
	const shown = $derived(tabbed ? [chosen ?? sections[0]] : sections);
</script>

{#if tabbed}
	<div class="tabs" role="tablist">
		{#each sections as section (section)}
			<button role="tab" aria-selected={shown[0] === section} onclick={() => (chosen = section)}>
				{section}
			</button>
		{/each}
	</div>
{/if}

{#each shown as section (section)}
	<section>
		{#if !tabbed}<h2>{section}</h2>{/if}
		{#each ids.filter((id) => controls[id].section === section) as id (id)}
			{@const spec = controls[id]}
			{#if spec.widget === 'slider'}
				<Slider
					{spec}
					value={edit[id] as number}
					initial={initial[id] as number}
					onchange={(value) => onchange(id, value as never)}
				/>
			{:else}
				<Wheel
					{spec}
					value={edit[id] as EditState['balance']}
					initial={initial[id] as EditState['balance']}
					onchange={(value) => onchange(id, value as never)}
				/>
			{/if}
		{/each}
	</section>
{/each}

<style>
	.tabs {
		display: flex;
		border-bottom: 1px solid var(--edge);
	}
	.tabs button {
		flex: 1;
		height: 26px;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		color: var(--dim);
	}
	.tabs button[aria-selected='true'] {
		color: var(--bright);
		border-bottom-color: var(--bright);
	}
	section {
		padding: 8px 10px;
		border-bottom: 1px solid var(--edge);
	}
	h2 {
		margin: 0 0 4px;
		font-size: inherit;
		font-weight: 600;
		color: var(--dim);
	}
</style>
