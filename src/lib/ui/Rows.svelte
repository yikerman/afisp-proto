<script lang="ts">
	import {
		added,
		additions,
		colour,
		describe,
		feather,
		removed,
		settings,
		toneRange,
		withTone,
		withWhat,
		withWhere,
		type Addition
	} from '../edit/rows';
	import { UNCHANGED, type Rows, type Tones, type What } from '../pipeline/adjustments/row';
	import Slider from './Slider.svelte';
	import Wheel from './Wheel.svelte';

	interface Props {
		rows: Rows;
		/** Id of the row whose where and what are shown. */
		selected: number;
		onselect: (id: number) => void;
		/** `action` names what the user did, for the log. */
		onchange: (action: string, value: unknown, rows: Rows) => void;
		/** Whether the selected row's area is marked on the picture. */
		marking: boolean;
		onmark: (marking: boolean) => void;
		/** Whether the next drag on the picture draws the selected row's place. */
		drawing: boolean;
		ondrawing: (drawing: boolean) => void;
	}
	let { rows, selected, onselect, onchange, marking, onmark, drawing, ondrawing }: Props = $props();

	const row = $derived(rows.find((r) => r.id === selected) ?? rows[0]);
	const whole = $derived(row.id === rows[0].id);
	const sliders = Object.entries(settings) as [
		keyof typeof settings,
		(typeof settings)['lightness']
	][];
	const edges = Object.entries(toneRange) as [keyof Tones, (typeof toneRange)['low']][];

	const what = (change: Partial<What>) =>
		onchange(
			`${row.name}: ${Object.keys(change)[0]}`,
			Object.values(change)[0],
			withWhat(rows, row.id, change)
		);

	function add(kind: Addition) {
		const next = added(rows, kind);
		const fresh = next.at(-1)!;
		onchange(`add ${additions[kind].name}`, fresh.id, next);
		onselect(fresh.id);
		// A place is useless until it has been put somewhere.
		ondrawing(fresh.where.place.kind !== 'everywhere');
	}

	function remove(id: number) {
		onchange(`remove ${rows.find((r) => r.id === id)!.name}`, id, removed(rows, id));
		onselect(rows[0].id);
	}
</script>

<ul class="rows">
	{#each rows as each (each.id)}
		<li aria-current={each.id === row.id}>
			<button class="name" onclick={() => onselect(each.id)}>
				<span>{each.name}</span>
				<span class="where">{describe(each.where)}</span>
			</button>
			{#if each.id !== rows[0].id}
				<button class="remove" aria-label="Remove {each.name}" onclick={() => remove(each.id)}>
					×
				</button>
			{/if}
		</li>
	{/each}
</ul>
<label class="add">
	<span>Add</span>
	<select
		value=""
		onchange={(event) => {
			add(event.currentTarget.value as Addition);
			event.currentTarget.value = '';
		}}
	>
		<option value="" disabled></option>
		{#each Object.entries(additions) as [kind, { name }] (kind)}
			<option value={kind}>{name}</option>
		{/each}
	</select>
</label>

{#if !whole}
	<details class="section" open>
		<summary>Where</summary>
		<div class="body">
			<div class="buttons">
				<button aria-pressed={marking} onclick={() => onmark(!marking)}>Show area</button>
				{#if row.where.place.kind !== 'everywhere'}
					<button aria-pressed={drawing} onclick={() => ondrawing(!drawing)}>
						Draw {row.where.place.kind}
					</button>
					<button
						aria-pressed={row.where.outside}
						onclick={() =>
							onchange(
								`${row.name}: outside`,
								!row.where.outside,
								withWhere(rows, row.id, { outside: !row.where.outside })
							)}
					>
						Outside
					</button>
				{/if}
			</div>
			{#if row.where.place.kind === 'ellipse'}
				{@const place = row.where.place}
				<Slider
					spec={feather}
					value={place.feather}
					initial={feather.default}
					onchange={(value) =>
						onchange(
							`${row.name}: feather`,
							value,
							withWhere(rows, row.id, { place: { ...place, feather: value } })
						)}
				/>
			{/if}
			{#each edges as [edge, spec] (edge)}
				<Slider
					{spec}
					value={row.where.tones[edge]}
					initial={spec.default}
					onchange={(value) =>
						onchange(
							`${row.name}: tones ${edge}`,
							value,
							withWhere(rows, row.id, { tones: withTone(row.where.tones, edge, value) })
						)}
				/>
			{/each}
		</div>
	</details>
{/if}

<details class="section" open>
	<summary>What</summary>
	<div class="body">
		{#each sliders as [setting, spec] (setting)}
			<Slider
				{spec}
				value={row.what[setting]}
				initial={UNCHANGED[setting]}
				onchange={(value) => what({ [setting]: value })}
			/>
		{/each}
		<Wheel
			spec={colour}
			value={row.what.colour}
			initial={UNCHANGED.colour}
			onchange={(value) => what({ colour: value })}
		/>
	</div>
</details>

<style>
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
		border-bottom: 1px solid var(--edge);
	}
	li {
		display: flex;
		border-left: 2px solid transparent;
	}
	li[aria-current='true'] {
		border-left-color: var(--bright);
		background: var(--field);
	}
	.name {
		flex: 1;
		display: flex;
		justify-content: space-between;
		gap: 8px;
		height: 24px;
		align-items: center;
		background: none;
		border: none;
		text-align: left;
	}
	li[aria-current='true'] .name {
		color: var(--bright);
	}
	.where {
		color: var(--dim);
	}
	.remove {
		width: 24px;
		height: 24px;
		padding: 0;
		background: none;
		border: none;
		color: var(--dim);
	}
	.add {
		display: grid;
		grid-template-columns: 84px 1fr;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--edge);
	}
	select {
		height: 18px;
		font: inherit;
		color: inherit;
		background: var(--field);
		border: 1px solid var(--edge);
		border-radius: 0;
	}
	.section {
		border-bottom: 1px solid var(--edge);
	}
	summary {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 26px;
		padding: 0 10px;
		font-weight: 600;
		background: var(--field);
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
	.body {
		padding: 6px 10px 8px;
	}
	.buttons {
		display: flex;
		gap: 6px;
		margin-bottom: 6px;
	}
	button[aria-pressed='true'] {
		color: var(--bright);
		border-color: var(--bright);
	}
</style>
