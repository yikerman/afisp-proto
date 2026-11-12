import type { Vec2 } from '../../math/matrix';

/**
 * A part of the picture chosen by position. Points are fractions of the image's
 * width and height; lengths are fractions of its width.
 */
export type Place =
	| { readonly kind: 'everywhere' }
	/** Full at `from`, fading to nothing at `to`, constant across the line between them. */
	| { readonly kind: 'gradient'; readonly from: Vec2; readonly to: Vec2 }
	| {
			readonly kind: 'ellipse';
			readonly centre: Vec2;
			readonly radii: Vec2;
			/** Radians, anticlockwise. */
			readonly angle: number;
			/** How far past its edge the ellipse fades out, as a fraction of its size. */
			readonly feather: number;
	  };

/**
 * A range of tones in stops relative to middle grey: full between `low` and
 * `high`, fading to nothing over `softness` stops outside them.
 */
export interface Tones {
	readonly low: number;
	readonly high: number;
	readonly softness: number;
}

/** The tone field has no values outside these, so a range reaching both ends is every tone. */
export const DARKEST = -16;
export const BRIGHTEST = 16;
export const ALL_TONES: Tones = { low: DARKEST, high: BRIGHTEST, softness: 0 };

/** Where an adjustment applies: a place, limited to a range of tones. */
export interface Where {
	readonly place: Place;
	/** The rest of the picture instead of the place. */
	readonly outside: boolean;
	readonly tones: Tones;
}

/** What an adjustment does where it applies. Each setting is zero-effect at the value noted. */
export interface What {
	/** Stops added. 0 changes nothing. */
	readonly lightness: number;
	/** Slope of output tone against input tone about the area's average tone. 1 changes nothing. */
	readonly contrast: number;
	/** Stops added per stop that a pixel stands out from its surroundings. 0 changes nothing. */
	readonly detail: number;
	/** Shift of every colour towards a hue, in the uniform colour space. [0, 0] changes nothing. */
	readonly colour: Vec2;
	/** Scale of colourfulness. 1 changes nothing, 0 removes colour. */
	readonly saturation: number;
}

export const UNCHANGED: What = {
	lightness: 0,
	contrast: 1,
	detail: 0,
	colour: [0, 0],
	saturation: 1
};

/** One adjustment: where, and what. */
export interface Row {
	readonly id: number;
	readonly name: string;
	readonly where: Where;
	readonly what: What;
}

/** The adjustments of an edit. There is always at least the whole picture. */
export type Rows = readonly [Row, ...Row[]];

export const EVERYWHERE: Where = {
	place: { kind: 'everywhere' },
	outside: false,
	tones: ALL_TONES
};

// The three tone ranges meet at middle grey with matching soft edges, so equal
// settings on all three are the same as that setting on the whole picture.
const HANDOVER = 4;
export const SHADOWS: Tones = { low: DARKEST, high: -HANDOVER, softness: HANDOVER };
export const MIDTONES: Tones = { low: 0, high: 0, softness: HANDOVER };
export const HIGHLIGHTS: Tones = { low: HANDOVER, high: BRIGHTEST, softness: HANDOVER };
