import { chromaticity, illuminant } from '../colour/illuminant';
import { D65, type Chromaticity } from '../colour/spaces';
import type { Vec2 } from '../math/matrix';
import {
	controlIds,
	controls,
	restoration,
	slider,
	type Choice,
	type Control,
	type EditState
} from './controls';

/**
 * Something shown in a panel: a widget, and how its value relates to the edit.
 *
 * Most items are a control's own value. The rest are other ways to read and
 * set values the edit already holds, such as the light's hue and chroma beside
 * its temperature and tint. They add no state, so they cannot disagree with it.
 */
export interface Item {
	readonly id: string;
	readonly spec: Control;
	/** `initial` is the edit the file opened with. */
	read(state: EditState, initial: EditState): unknown;
	/** The part of the edit that changes when the item is set to `value`. */
	write(value: never, state: EditState, initial: EditState): Partial<EditState>;
}

const own = controlIds.map((id): Item => ({
	id,
	spec: controls[id],
	read: (state) => state[id],
	write: (value) => ({ [id]: value })
}));

const light = { ...restoration, section: 'White balance', advanced: true } as const;

// CIE standard illuminants (CIE 15:2004), named as in darktable's color calibration.
const STANDARD_LIGHTS = {
	d50: { label: 'D50 (daylight)', xy: [0.3457, 0.3585] },
	d55: { label: 'D55 (daylight)', xy: [0.3324, 0.3474] },
	d65: { label: 'D65 (daylight)', xy: [0.3127, 0.329] },
	d75: { label: 'D75 (daylight)', xy: [0.299, 0.3149] },
	a: { label: 'A (incandescent)', xy: [0.4476, 0.4074] },
	f2: { label: 'F2 (fluorescent)', xy: [0.3721, 0.3751] }
} as const satisfies Record<string, { label: string; xy: Chromaticity }>;

type LightName = 'as-shot' | keyof typeof STANDARD_LIGHTS | 'custom';

const namedLight = (name: Exclude<LightName, 'custom'>, initial: EditState) =>
	name === 'as-shot'
		? { temperature: initial.temperature, tint: initial.tint }
		: illuminant(STANDARD_LIGHTS[name].xy);

const lightNames = ['as-shot', ...Object.keys(STANDARD_LIGHTS)] as Exclude<LightName, 'custom'>[];

// A named light is recognised to the precision the sliders show.
const sameLight = (a: Pick<EditState, 'temperature' | 'tint'>, b: typeof a) =>
	Math.abs(a.temperature - b.temperature) < 5 && Math.abs(a.tint - b.tint) < 0.05;

const lightSource: Item = {
	id: 'lightSource',
	spec: {
		widget: 'choice',
		...light,
		label: 'Light source',
		options: [
			{ value: 'as-shot', label: 'As shot' },
			...Object.entries(STANDARD_LIGHTS).map(([value, { label }]) => ({ value, label })),
			{ value: 'custom', label: 'Custom' }
		],
		default: 'as-shot'
	} satisfies Choice,
	read: (state, initial): LightName =>
		lightNames.find((name) => sameLight(state, namedLight(name, initial))) ?? 'custom',
	write: (name: LightName, _, initial) => (name === 'custom' ? {} : namedLight(name, initial))
};

// The light's colour as hue and chroma, as darktable's color calibration offers
// for a custom illuminant: polar coordinates of its CIE 1976 u'v' chromaticity
// about D65, scaled as CIELUV does at L* = 100.
const LUV_SCALE = 1300;

const toUv = ([x, y]: Chromaticity): Vec2 => {
	const d = -2 * x + 12 * y + 3;
	return [(4 * x) / d, (9 * y) / d];
};
const toXy = ([u, v]: Vec2): Chromaticity => {
	const d = 6 * u - 16 * v + 12;
	return [(9 * u) / d, (4 * v) / d];
};
const NEUTRAL = toUv(D65);

interface Polar {
	/** Degrees, anticlockwise from the +u axis. */
	readonly hue: number;
	readonly chroma: number;
}

function polar(state: EditState): Polar {
	const [u, v] = toUv(chromaticity(state));
	const [du, dv] = [(u - NEUTRAL[0]) * LUV_SCALE, (v - NEUTRAL[1]) * LUV_SCALE];
	return { hue: ((Math.atan2(dv, du) * 180) / Math.PI + 360) % 360, chroma: Math.hypot(du, dv) };
}

function fromPolar({ hue, chroma }: Polar) {
	const angle = (hue * Math.PI) / 180;
	return illuminant(
		toXy([
			NEUTRAL[0] + (chroma * Math.cos(angle)) / LUV_SCALE,
			NEUTRAL[1] + (chroma * Math.sin(angle)) / LUV_SCALE
		])
	);
}

const lightHue: Item = {
	id: 'lightHue',
	spec: slider({ ...light, label: 'Hue', unit: '°', step: 0.1, min: 0, max: 360, default: 0 }),
	read: (state) => polar(state).hue,
	write: (hue: number, state) => fromPolar({ ...polar(state), hue })
};

const lightChroma: Item = {
	id: 'lightChroma',
	spec: slider({ ...light, label: 'Chroma', unit: '', step: 0.1, min: 0, max: 250, default: 0 }),
	read: (state) => polar(state).chroma,
	write: (chroma: number, state) => fromPolar({ ...polar(state), chroma })
};

/** Every panel item, in display order within its section. */
export const items: readonly Item[] = [...own, lightSource, lightHue, lightChroma];
