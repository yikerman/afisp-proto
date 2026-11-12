import type { Vec2 } from '../../math/matrix';

/**
 * A part of the picture chosen by position. Points are fractions of the image's
 * width and height; lengths are fractions of its width.
 */
export type Shape =
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

/** Something that selects part of the picture, as a weight from 0 to 1 at each pixel. */
export type Element =
	| Shape
	| ({ readonly kind: 'tones' } & Tones)
	/** Where another row applies. The row must come earlier in the list. */
	| { readonly kind: 'area'; readonly row: number };

/** How an element changes the area built so far. */
export type How =
	/** Keep only what the element also selects. */
	| 'intersect'
	/** Extend by what the element selects. */
	| 'add'
	/** Remove what the element selects. */
	| 'subtract';

export interface Step {
	readonly how: How;
	readonly element: Element;
}

/**
 * Where an adjustment applies: the whole picture, changed by each step in turn.
 * No steps is the whole picture.
 */
export type Where = readonly Step[];

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

/** One modification of the picture: where, and what. */
export interface Row {
	readonly id: number;
	readonly name: string;
	readonly where: Where;
	readonly what: What;
}

/** The adjustments of an edit. There is always at least the whole picture. */
export type Rows = readonly [Row, ...Row[]];

export const EVERYWHERE: Where = [];

// The three tone ranges meet at middle grey with matching soft edges, so equal
// settings on all three are the same as that setting on the whole picture.
const HANDOVER = 4;
export const SHADOWS: Tones = { low: DARKEST, high: -HANDOVER, softness: HANDOVER };
export const MIDTONES: Tones = { low: 0, high: 0, softness: HANDOVER };
export const HIGHLIGHTS: Tones = { low: HANDOVER, high: BRIGHTEST, softness: HANDOVER };
