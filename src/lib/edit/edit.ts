import { balance, saturation } from '../pipeline/adjustments/colour';
import { everywhere } from '../pipeline/adjustments/mask';
import { instance } from '../pipeline/adjustments/module';
import { toneCurve, toneEqualizer } from '../pipeline/adjustments/toneEqualizer';
import type { Edit } from '../pipeline/render';
import { asShotIlluminant } from '../pipeline/restoration/calibrate';
import type { RawMeta } from '../raw/decode';
import { defaults, type EditState } from './controls';

/** The state a file opens with: defaults, lit as the camera recorded. */
export const initialState = (meta: RawMeta): EditState => ({
	...defaults,
	...asShotIlluminant(meta)
});

/** What the controls mean to the pipeline. */
export const toEdit = (state: EditState): Edit => ({
	calibration: {
		light: { temperature: state.temperature, tint: state.tint },
		exposure: state.exposure
	},
	adjustments: [
		instance(toneEqualizer, { nodes: toneCurve(state) }, everywhere),
		instance(saturation, { amount: state.saturation }, everywhere),
		instance(balance, { shift: state.balance }, everywhere)
	]
});
