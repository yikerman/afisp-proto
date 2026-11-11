export const RED = 0;
export const GREEN = 1;
export const BLUE = 2;
export type Channel = typeof RED | typeof GREEN | typeof BLUE;

/**
 * Colour of the filter over each site of the repeating 2x2 block, indexed by
 * `(y % 2) * 2 + (x % 2)` in image coordinates.
 */
export type BayerPattern = readonly [Channel, Channel, Channel, Channel];
