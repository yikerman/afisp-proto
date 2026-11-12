import { expect, test } from 'vitest';
import { acquireGpu, type Gpu } from '../../gpu/gpu';
import { download, upload, type Size } from '../../gpu/image';
import type { BayerPattern } from '../../raw/bayer';
import { demosaic } from './demosaic';

/*
 * Oracle: darktable's CPU RCD in float64, ported from src/iop/demosaicing/rcd.c (rcd_demosaic)
 * and src/iop/demosaicing/ppg.c (demosaic_ppg, its border fill) at darktable master
 * bdce4fed98499b90077946e323f08069b979ee79, GPL-3.0-or-later. Tiling, half-width buffers and
 * index arithmetic are kept as in the C. The one change is in step 4.0, marked below, matching
 * the deliberate deviation in demosaic.ts. Scale is 1 (see demosaic.ts), median threshold 0.
 */

const TILESIZE = 112; // DT_RCD_TILESIZE
const RCD_BORDER = 10;
const RCD_MARGIN = 9;
const RCD_TILEVALID = TILESIZE - 2 * RCD_BORDER;
const w1 = TILESIZE;
const w2 = 2 * TILESIZE;
const w3 = 3 * TILESIZE;
const w4 = 4 * TILESIZE;
const eps = 1e-5;
const epssq = 1e-10;

const sqrf = (a: number) => a * a;
const mixf = (x: number, y: number, a: number) => (y - x) * a + x;
const CLIP = (x: number) => (x >= 0 ? (x <= 1 ? x : 1) : 0);

function demosaicPpg(
	out: Float64Array,
	input: Float64Array,
	width: number,
	height: number,
	FC: (row: number, col: number) => number,
	margin: number
): void {
	// preliminary border interpolate for outermost 3 pixels
	for (let j = 0; j < height; j++) {
		for (let i = 0; i < width; i++) {
			if (i === 3 && j >= 3 && j < height - 3) i = width - 3;
			if (i === width) break;
			const sum = [0, 0, 0, 0, 0, 0, 0, 0];
			for (let y = j - 1; y !== j + 2; y++) {
				for (let x = i - 1; x !== i + 2; x++) {
					if (y >= 0 && x >= 0 && y < height && x < width) {
						const f = FC(y, x);
						sum[f] += input[y * width + x];
						sum[f + 4]++;
					}
				}
			}
			const f = FC(j, i);
			for (let c = 0; c < 3; c++) {
				if (c !== f && sum[c + 4] > 0)
					out[4 * (j * width + i) + c] = Math.max(0, sum[c] / sum[c + 4]);
				else out[4 * (j * width + i) + c] = Math.max(0, input[j * width + i]);
			}
		}
	}

	const border = margin + 3;
	for (let j = 3; j < height - 3; j++) {
		for (let i = 3; i < width - 3; i++) {
			if (i === border && j >= border && j < height - border) i = width - border;
			if (i === width) break;
			const at = (dy: number, dx: number) => input[(j + dy) * width + i + dx];
			const c = FC(j, i);
			const color = [0, 0, 0, 0];
			const pc = at(0, 0);
			if (c === 0 || c === 2) {
				color[c] = pc;
				const [pym, pym2, pym3, pyM, pyM2, pyM3] = [
					at(-1, 0),
					at(-2, 0),
					at(-3, 0),
					at(1, 0),
					at(2, 0),
					at(3, 0)
				];
				const [pxm, pxm2, pxm3, pxM, pxM2, pxM3] = [
					at(0, -1),
					at(0, -2),
					at(0, -3),
					at(0, 1),
					at(0, 2),
					at(0, 3)
				];
				const guessx = (pxm + pc + pxM) * 2 - pxM2 - pxm2;
				const diffx =
					(Math.abs(pxm2 - pc) + Math.abs(pxM2 - pc) + Math.abs(pxm - pxM)) * 3 +
					(Math.abs(pxM3 - pxM) + Math.abs(pxm3 - pxm)) * 2;
				const guessy = (pym + pc + pyM) * 2 - pyM2 - pym2;
				const diffy =
					(Math.abs(pym2 - pc) + Math.abs(pyM2 - pc) + Math.abs(pym - pyM)) * 3 +
					(Math.abs(pyM3 - pyM) + Math.abs(pym3 - pym)) * 2;
				if (diffx > diffy) {
					color[1] = Math.max(Math.min(guessy * 0.25, Math.max(pym, pyM)), Math.min(pym, pyM));
				} else {
					color[1] = Math.max(Math.min(guessx * 0.25, Math.max(pxm, pxM)), Math.min(pxm, pxM));
				}
			} else color[1] = pc;
			for (let k = 0; k < 4; k++) out[4 * (j * width + i) + k] = Math.max(0, color[k]);
		}
	}

	for (let j = 0; j < height; j++) {
		for (let i = 0; i < width; i++) {
			if (i === margin && j >= margin && j < height - margin) i = width - margin;
			const buf = 4 * (j * width + i);
			const color = [out[buf], out[buf + 1], out[buf + 2], out[buf + 3]];
			if (j > 0 && i > 0 && i < width - 1 && j < height - 1) {
				const c = FC(j, i);
				const n = (dy: number, dx: number, k: number) => out[buf + 4 * (dy * width + dx) + k];
				if (c & 1) {
					if (FC(j, i + 1) === 0) {
						color[2] = (n(-1, 0, 2) + n(1, 0, 2) + 2 * color[1] - n(-1, 0, 1) - n(1, 0, 1)) * 0.5;
						color[0] = (n(0, -1, 0) + n(0, 1, 0) + 2 * color[1] - n(0, -1, 1) - n(0, 1, 1)) * 0.5;
					} else {
						color[0] = (n(-1, 0, 0) + n(1, 0, 0) + 2 * color[1] - n(-1, 0, 1) - n(1, 0, 1)) * 0.5;
						color[2] = (n(0, -1, 2) + n(0, 1, 2) + 2 * color[1] - n(0, -1, 1) - n(0, 1, 1)) * 0.5;
					}
				} else {
					const o = c === 0 ? 2 : 0;
					const diff1 =
						Math.abs(n(-1, -1, o) - n(1, 1, o)) +
						Math.abs(n(-1, -1, 1) - color[1]) +
						Math.abs(n(1, 1, 1) - color[1]);
					const guess1 = n(-1, -1, o) + n(1, 1, o) + 2 * color[1] - n(-1, -1, 1) - n(1, 1, 1);
					const diff2 =
						Math.abs(n(-1, 1, o) - n(1, -1, o)) +
						Math.abs(n(-1, 1, 1) - color[1]) +
						Math.abs(n(1, -1, 1) - color[1]);
					const guess2 = n(-1, 1, o) + n(1, -1, o) + 2 * color[1] - n(-1, 1, 1) - n(1, -1, 1);
					if (diff1 > diff2) color[o] = guess2 * 0.5;
					else if (diff1 < diff2) color[o] = guess1 * 0.5;
					else color[o] = (guess1 + guess2) * 0.25;
				}
			}
			for (let k = 0; k < 4; k++) out[buf + k] = Math.max(0, color[k]);
		}
	}
}

function rcdDemosaic(input: Float64Array, width: number, height: number, pattern: BayerPattern) {
	const FC = (row: number, col: number) => pattern[(row & 1) * 2 + (col & 1)];
	const out = new Float64Array(4 * width * height);
	demosaicPpg(out, input, width, height, FC, RCD_BORDER);
	if (width < 2 * RCD_BORDER || height < 2 * RCD_BORDER) return out;

	const num_vertical = 1 + Math.trunc((height - 2 * RCD_BORDER - 1) / RCD_TILEVALID);
	const num_horizontal = 1 + Math.trunc((width - 2 * RCD_BORDER - 1) / RCD_TILEVALID);

	const VH_Dir = new Float64Array(TILESIZE * TILESIZE);
	const PQ_Dir = new Float64Array((TILESIZE * TILESIZE) / 2);
	const cfa = new Float64Array(TILESIZE * TILESIZE);
	const P_CDiff_Hpf = new Float64Array((TILESIZE * TILESIZE) / 2);
	const Q_CDiff_Hpf = new Float64Array((TILESIZE * TILESIZE) / 2);
	const rgb = [0, 1, 2].map(() => new Float64Array(TILESIZE * TILESIZE));
	const lpf = PQ_Dir;
	const half = (i: number) => Math.trunc(i / 2);

	for (let tile_vertical = 0; tile_vertical < num_vertical; tile_vertical++) {
		for (let tile_horizontal = 0; tile_horizontal < num_horizontal; tile_horizontal++) {
			const rowStart = tile_vertical * RCD_TILEVALID;
			const rowEnd = Math.min(rowStart + TILESIZE, height);
			const colStart = tile_horizontal * RCD_TILEVALID;
			const colEnd = Math.min(colStart + TILESIZE, width);
			const tileRows = Math.min(rowEnd - rowStart, TILESIZE);
			const tileCols = Math.min(colEnd - colStart, TILESIZE);

			if (rowStart + TILESIZE > height || colStart + TILESIZE > width) {
				VH_Dir.fill(0);
				for (const plane of rgb) plane.fill(0);
			}
			// Step 0: fill data
			for (let row = rowStart; row < rowEnd; row++) {
				const c0 = FC(row, colStart);
				const c1 = FC(row, colStart + 1);
				for (
					let col = colStart, indx = (row - rowStart) * TILESIZE, in_indx = row * width + colStart;
					col < colEnd;
					col++, indx++, in_indx++
				) {
					cfa[indx] = rgb[c0][indx] = rgb[c1][indx] = Math.max(0, input[in_indx]);
				}
			}

			// STEP 1: Find vertical and horizontal interpolation directions
			const vdiff = (indx: number) =>
				sqrf(
					cfa[indx - w3] -
						cfa[indx - w1] -
						cfa[indx + w1] +
						cfa[indx + w3] -
						3 * (cfa[indx - w2] + cfa[indx + w2]) +
						6 * cfa[indx]
				);
			const hdiff = (indx: number) =>
				sqrf(
					cfa[indx - 3] -
						cfa[indx - 1] -
						cfa[indx + 1] +
						cfa[indx + 3] -
						3 * (cfa[indx - 2] + cfa[indx + 2]) +
						6 * cfa[indx]
				);
			const bufferV = [0, 1, 2].map(() => new Float64Array(TILESIZE - 8));
			for (let row = 3; row < Math.min(tileRows - 3, 5); row++) {
				for (let col = 4, indx = row * TILESIZE + col; col < tileCols - 4; col++, indx++) {
					bufferV[row - 3][col - 4] = vdiff(indx);
				}
			}
			const bufferH = new Float64Array(TILESIZE);
			let [V0, V1, V2] = bufferV;
			for (let row = 4; row < tileRows - 4; row++) {
				for (let col = 3, indx = row * TILESIZE + col; col < tileCols - 3; col++, indx++) {
					bufferH[col - 3] = hdiff(indx);
				}
				for (let col = 4, indx = (row + 1) * TILESIZE + col; col < tileCols - 4; col++, indx++) {
					V2[col - 4] = vdiff(indx);
				}
				for (let col = 4, indx = row * TILESIZE + col; col < tileCols - 4; col++, indx++) {
					const V_Stat = Math.max(epssq, V0[col - 4] + V1[col - 4] + V2[col - 4]);
					const H_Stat = Math.max(epssq, bufferH[col - 4] + bufferH[col - 3] + bufferH[col - 2]);
					VH_Dir[indx] = V_Stat / (V_Stat + H_Stat);
				}
				[V0, V1, V2] = [V1, V2, V0];
			}

			// STEP 2: Calculate the low pass filter
			for (let row = 2; row < tileRows - 2; row++) {
				for (
					let col = 2 + (FC(row, 0) & 1), indx = row * TILESIZE + col, lp_indx = half(indx);
					col < tileCols - 2;
					col += 2, indx += 2, lp_indx++
				) {
					lpf[lp_indx] =
						cfa[indx] +
						0.5 * (cfa[indx - w1] + cfa[indx + w1] + cfa[indx - 1] + cfa[indx + 1]) +
						0.25 *
							(cfa[indx - w1 - 1] + cfa[indx - w1 + 1] + cfa[indx + w1 - 1] + cfa[indx + w1 + 1]);
				}
			}

			// STEP 3: Populate the green channel at blue and red CFA positions
			for (let row = 4; row < tileRows - 4; row++) {
				for (
					let col = 4 + (FC(row, 0) & 1), indx = row * TILESIZE + col, lpindx = half(indx);
					col < tileCols - 4;
					col += 2, indx += 2, lpindx++
				) {
					const cfai = cfa[indx];
					const abs = Math.abs;
					const N_Grad =
						eps +
						abs(cfa[indx - w1] - cfa[indx + w1]) +
						abs(cfai - cfa[indx - w2]) +
						abs(cfa[indx - w1] - cfa[indx - w3]) +
						abs(cfa[indx - w2] - cfa[indx - w4]);
					const S_Grad =
						eps +
						abs(cfa[indx + w1] - cfa[indx - w1]) +
						abs(cfai - cfa[indx + w2]) +
						abs(cfa[indx + w1] - cfa[indx + w3]) +
						abs(cfa[indx + w2] - cfa[indx + w4]);
					const W_Grad =
						eps +
						abs(cfa[indx - 1] - cfa[indx + 1]) +
						abs(cfai - cfa[indx - 2]) +
						abs(cfa[indx - 1] - cfa[indx - 3]) +
						abs(cfa[indx - 2] - cfa[indx - 4]);
					const E_Grad =
						eps +
						abs(cfa[indx + 1] - cfa[indx - 1]) +
						abs(cfai - cfa[indx + 2]) +
						abs(cfa[indx + 1] - cfa[indx + 3]) +
						abs(cfa[indx + 2] - cfa[indx + 4]);

					const lpfi = lpf[lpindx];
					const N_Est = (cfa[indx - w1] * (lpfi + lpfi)) / (eps + lpfi + lpf[lpindx - w1]);
					const S_Est = (cfa[indx + w1] * (lpfi + lpfi)) / (eps + lpfi + lpf[lpindx + w1]);
					const W_Est = (cfa[indx - 1] * (lpfi + lpfi)) / (eps + lpfi + lpf[lpindx - 1]);
					const E_Est = (cfa[indx + 1] * (lpfi + lpfi)) / (eps + lpfi + lpf[lpindx + 1]);

					const V_Est = (S_Grad * N_Est + N_Grad * S_Est) / (N_Grad + S_Grad);
					const H_Est = (W_Grad * E_Est + E_Grad * W_Est) / (E_Grad + W_Grad);

					const VH_Central_Value = VH_Dir[indx];
					const VH_Neighbourhood_Value =
						0.25 *
						(VH_Dir[indx - w1 - 1] +
							VH_Dir[indx - w1 + 1] +
							VH_Dir[indx + w1 - 1] +
							VH_Dir[indx + w1 + 1]);
					const VH_Disc =
						abs(0.5 - VH_Central_Value) < abs(0.5 - VH_Neighbourhood_Value)
							? VH_Neighbourhood_Value
							: VH_Central_Value;

					rgb[1][indx] = mixf(V_Est, H_Est, CLIP(VH_Disc));
				}
			}

			// Step 4.0: Calculate the square of the P/Q diagonals color difference high pass filter
			for (let row = 3; row < tileRows - 3; row++) {
				// Deviation: rcd.c starts at col = 3 on every row, so the half-width buffers hold odd
				// columns, which are green on half the rows. Step 4.1 reads them as the red/blue site
				// in each column pair, so start at the first red/blue column instead.
				for (
					let col = 4 - (FC(row, 0) & 1), indx = row * TILESIZE + col, indx2 = half(indx);
					col < tileCols - 3;
					col += 2, indx += 2, indx2++
				) {
					P_CDiff_Hpf[indx2] = sqrf(
						cfa[indx - w3 - 3] -
							cfa[indx - w1 - 1] -
							cfa[indx + w1 + 1] +
							cfa[indx + w3 + 3] -
							3 * (cfa[indx - w2 - 2] + cfa[indx + w2 + 2]) +
							6 * cfa[indx]
					);
					Q_CDiff_Hpf[indx2] = sqrf(
						cfa[indx - w3 + 3] -
							cfa[indx - w1 + 1] -
							cfa[indx + w1 - 1] +
							cfa[indx + w3 - 3] -
							3 * (cfa[indx - w2 + 2] + cfa[indx + w2 - 2]) +
							6 * cfa[indx]
					);
				}
			}
			// Step 4.1: Obtain the P/Q diagonals directional discrimination strength
			for (let row = 4; row < tileRows - 4; row++) {
				for (
					let col = 4 + (FC(row, 0) & 1),
						indx = row * TILESIZE + col,
						indx2 = half(indx),
						indx3 = half(indx - w1 - 1),
						indx4 = half(indx + w1 - 1);
					col < tileCols - 4;
					col += 2, indx += 2, indx2++, indx3++, indx4++
				) {
					const P_Stat = Math.max(
						epssq,
						P_CDiff_Hpf[indx3] + P_CDiff_Hpf[indx2] + P_CDiff_Hpf[indx4 + 1]
					);
					const Q_Stat = Math.max(
						epssq,
						Q_CDiff_Hpf[indx3 + 1] + Q_CDiff_Hpf[indx2] + Q_CDiff_Hpf[indx4]
					);
					PQ_Dir[indx2] = P_Stat / (P_Stat + Q_Stat);
				}
			}

			// Step 4.2: Populate the red and blue channels at blue and red CFA positions
			for (let row = 4; row < tileRows - 4; row++) {
				const col0 = 4 + (FC(row, 0) & 1);
				const c = 2 - FC(row, col0);
				const rc = rgb[c];
				const r1 = rgb[1];
				for (
					let col = col0,
						indx = row * TILESIZE + col,
						pqindx = half(indx),
						pqindx2 = half(indx - w1 - 1),
						pqindx3 = half(indx + w1 - 1);
					col < tileCols - 4;
					col += 2, indx += 2, pqindx++, pqindx2++, pqindx3++
				) {
					const abs = Math.abs;
					const PQ_Central_Value = PQ_Dir[pqindx];
					const PQ_Neighbourhood_Value =
						0.25 * (PQ_Dir[pqindx2] + PQ_Dir[pqindx2 + 1] + PQ_Dir[pqindx3] + PQ_Dir[pqindx3 + 1]);
					const PQ_Disc =
						abs(0.5 - PQ_Central_Value) < abs(0.5 - PQ_Neighbourhood_Value)
							? PQ_Neighbourhood_Value
							: PQ_Central_Value;

					const NW_Grad =
						eps +
						abs(rc[indx - w1 - 1] - rc[indx + w1 + 1]) +
						abs(rc[indx - w1 - 1] - rc[indx - w3 - 3]) +
						abs(r1[indx] - r1[indx - w2 - 2]);
					const NE_Grad =
						eps +
						abs(rc[indx - w1 + 1] - rc[indx + w1 - 1]) +
						abs(rc[indx - w1 + 1] - rc[indx - w3 + 3]) +
						abs(r1[indx] - r1[indx - w2 + 2]);
					const SW_Grad =
						eps +
						abs(rc[indx - w1 + 1] - rc[indx + w1 - 1]) +
						abs(rc[indx + w1 - 1] - rc[indx + w3 - 3]) +
						abs(r1[indx] - r1[indx + w2 - 2]);
					const SE_Grad =
						eps +
						abs(rc[indx - w1 - 1] - rc[indx + w1 + 1]) +
						abs(rc[indx + w1 + 1] - rc[indx + w3 + 3]) +
						abs(r1[indx] - r1[indx + w2 + 2]);

					const NW_Est = rc[indx - w1 - 1] - r1[indx - w1 - 1];
					const NE_Est = rc[indx - w1 + 1] - r1[indx - w1 + 1];
					const SW_Est = rc[indx + w1 - 1] - r1[indx + w1 - 1];
					const SE_Est = rc[indx + w1 + 1] - r1[indx + w1 + 1];

					const P_Est = (NW_Grad * SE_Est + SE_Grad * NW_Est) / (NW_Grad + SE_Grad);
					const Q_Est = (NE_Grad * SW_Est + SW_Grad * NE_Est) / (NE_Grad + SW_Grad);

					rc[indx] = r1[indx] + mixf(P_Est, Q_Est, CLIP(PQ_Disc));
				}
			}

			// Step 4.3: Populate the red and blue channels at green CFA positions
			for (let row = 4; row < tileRows - 4; row++) {
				for (
					let col = 4 + (FC(row, 1) & 1), indx = row * TILESIZE + col;
					col < tileCols - 4;
					col += 2, indx += 2
				) {
					const abs = Math.abs;
					const r1 = rgb[1];
					const VH_Central_Value = VH_Dir[indx];
					const VH_Neighbourhood_Value =
						0.25 *
						(VH_Dir[indx - w1 - 1] +
							VH_Dir[indx - w1 + 1] +
							VH_Dir[indx + w1 - 1] +
							VH_Dir[indx + w1 + 1]);
					const VH_Disc =
						abs(0.5 - VH_Central_Value) < abs(0.5 - VH_Neighbourhood_Value)
							? VH_Neighbourhood_Value
							: VH_Central_Value;
					const rgb1 = r1[indx];
					const N1 = eps + abs(rgb1 - r1[indx - w2]);
					const S1 = eps + abs(rgb1 - r1[indx + w2]);
					const W1 = eps + abs(rgb1 - r1[indx - 2]);
					const E1 = eps + abs(rgb1 - r1[indx + 2]);

					const rgb1mw1 = r1[indx - w1];
					const rgb1pw1 = r1[indx + w1];
					const rgb1m1 = r1[indx - 1];
					const rgb1p1 = r1[indx + 1];

					for (let c = 0; c <= 2; c += 2) {
						const rc = rgb[c];
						const SNabs = abs(rc[indx - w1] - rc[indx + w1]);
						const EWabs = abs(rc[indx - 1] - rc[indx + 1]);

						const N_Grad = N1 + SNabs + abs(rc[indx - w1] - rc[indx - w3]);
						const S_Grad = S1 + SNabs + abs(rc[indx + w1] - rc[indx + w3]);
						const W_Grad = W1 + EWabs + abs(rc[indx - 1] - rc[indx - 3]);
						const E_Grad = E1 + EWabs + abs(rc[indx + 1] - rc[indx + 3]);

						const N_Est = rc[indx - w1] - rgb1mw1;
						const S_Est = rc[indx + w1] - rgb1pw1;
						const W_Est = rc[indx - 1] - rgb1m1;
						const E_Est = rc[indx + 1] - rgb1p1;

						const V_Est = (N_Grad * S_Est + S_Grad * N_Est) / (N_Grad + S_Grad);
						const H_Est = (E_Grad * W_Est + W_Grad * E_Est) / (E_Grad + W_Grad);

						rc[indx] = rgb1 + mixf(V_Est, H_Est, CLIP(VH_Disc));
					}
				}
			}

			const first_vertical = rowStart + (tile_vertical === 0 ? RCD_MARGIN : RCD_BORDER);
			const last_vertical = rowEnd - (tile_vertical === num_vertical - 1 ? RCD_MARGIN : RCD_BORDER);
			const first_horizontal = colStart + (tile_horizontal === 0 ? RCD_MARGIN : RCD_BORDER);
			const last_horizontal =
				colEnd - (tile_horizontal === num_horizontal - 1 ? RCD_MARGIN : RCD_BORDER);
			for (let row = first_vertical; row < last_vertical; row++) {
				for (
					let col = first_horizontal,
						idx = (row - rowStart) * TILESIZE + col - colStart,
						o_idx = (row * width + col) * 4;
					col < last_horizontal;
					col++, o_idx += 4, idx++
				) {
					out[o_idx] = Math.max(0, rgb[0][idx]);
					out[o_idx + 1] = Math.max(0, rgb[1][idx]);
					out[o_idx + 2] = Math.max(0, rgb[2][idx]);
					out[o_idx + 3] = 0;
				}
			}
		}
	}
	return out;
}

const patterns: Record<string, BayerPattern> = {
	RGGB: [0, 1, 1, 2],
	GRBG: [1, 0, 2, 1],
	GBRG: [1, 2, 0, 1],
	BGGR: [2, 1, 1, 0]
};

const size: Size = { width: 64, height: 48 };
const channel = (pattern: BayerPattern, x: number, y: number) => pattern[(y % 2) * 2 + (x % 2)];

/** A scene with smooth gradients, a coloured disc, a diagonal edge, fine stripes and noise. */
function scene(x: number, y: number): [number, number, number] {
	let rgb: [number, number, number] = [
		0.1 + (0.5 * x) / size.width,
		0.2 + (0.4 * y) / size.height,
		0.3
	];
	if ((x - 22) ** 2 + (y - 24) ** 2 < 100) rgb = [0.8, 0.15, 0.1];
	if (x + 0.6 * y > 52) rgb = [0.1, 0.3, 0.85];
	if (x >= 44 && x < 60 && y < 18) {
		const stripe = 0.5 + 0.4 * Math.sin((2 * Math.PI * x) / 3.3);
		rgb = [stripe, stripe * 0.9, stripe * 0.7];
	}
	return rgb;
}

function mosaicOf(pattern: BayerPattern, value: (x: number, y: number, c: number) => number) {
	const pixels = new Float32Array(size.width * size.height);
	for (let y = 0; y < size.height; y++) {
		for (let x = 0; x < size.width; x++) {
			pixels[y * size.width + x] = value(x, y, channel(pattern, x, y));
		}
	}
	return pixels;
}

function syntheticMosaic(pattern: BayerPattern): Float32Array {
	let state = 12345; // xorshift32
	const noise = () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return ((state >>> 0) / 2 ** 32 - 0.5) * 0.02;
	};
	return mosaicOf(pattern, (x, y, c) => Math.min(1, Math.max(0, scene(x, y)[c] + noise())));
}

async function runDemosaic(gpu: Gpu, pixels: Float32Array, pattern: BayerPattern) {
	const mosaic = upload<'mosaic'>(gpu, size, 'R32F', pixels);
	const result = demosaic(gpu, mosaic, pattern);
	const out = new Float16Array(await download(gpu, result));
	mosaic.destroy();
	result.destroy();
	return out;
}

/*
 * Tolerance. A correctly rounded half float is within 2^-11 relative of the exact value (2^-25
 * absolute in the subnormal range). The GPU's float32 arithmetic may push a result across a
 * rounding boundary, so allow 2^-16 relative on top. Measured: at most 0.501 half-float ulp at
 * any sample, here and on a 250x130 image spanning 3x2 of rcd.c's tiles. A flipped direction
 * decision or a misplaced stencil shows as errors of 1e-2 and more.
 */
const tolerance = (expected: number) => (2 ** -11 + 2 ** -16) * Math.abs(expected) + 2 ** -24;

for (const [name, pattern] of Object.entries(patterns)) {
	test(`matches the CPU RCD oracle, ${name}`, async () => {
		const gpu = await acquireGpu('accept');
		const pixels = syntheticMosaic(pattern);
		const got = await runDemosaic(gpu, pixels, pattern);
		const expected = rcdDemosaic(Float64Array.from(pixels), size.width, size.height, pattern);

		let maxError = 0;
		let maxExcess = -Infinity;
		for (let i = 0; i < size.width * size.height; i++) {
			for (let c = 0; c < 3; c++) {
				const error = Math.abs(got[4 * i + c] - expected[4 * i + c]);
				maxError = Math.max(maxError, error);
				maxExcess = Math.max(maxExcess, error - tolerance(expected[4 * i + c]));
			}
			expect(got[4 * i + 3]).toBe(1);
		}
		expect(maxExcess).toBeLessThanOrEqual(0);
	});
}

test('measured samples are preserved', async () => {
	const gpu = await acquireGpu('accept');
	for (const pattern of Object.values(patterns)) {
		const pixels = syntheticMosaic(pattern);
		const got = await runDemosaic(gpu, pixels, pattern);
		for (let y = 0; y < size.height; y++) {
			for (let x = 0; x < size.width; x++) {
				const i = y * size.width + x;
				expect(got[4 * i + channel(pattern, x, y)]).toBe(Math.f16round(pixels[i]));
			}
		}
	}
});

test('a constant grey mosaic gives a constant grey image', async () => {
	const gpu = await acquireGpu('accept');
	for (const pattern of Object.values(patterns)) {
		for (const grey of [0, 0.18, 1]) {
			const got = await runDemosaic(
				gpu,
				mosaicOf(pattern, () => grey),
				pattern
			);
			const values = new Set(got.filter((_, i) => i % 4 !== 3));
			expect([...values]).toEqual([Math.f16round(grey)]);
		}
	}
});
