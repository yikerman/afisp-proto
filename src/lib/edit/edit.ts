import type { Edit, LensChoice } from '../pipeline/render';
import { asShotIlluminant } from '../pipeline/restoration/calibrate';
import type { RawMeta } from '../raw/decode';
import { defaults, type EditState } from './controls';

/** The state a file opens with: defaults, lit as the camera recorded. */
export const initialState = (meta: RawMeta): EditState => ({
	...defaults,
	...asShotIlluminant(meta)
});

/** What the controls mean to the pipeline. */
const lensChoice = (state: EditState): LensChoice =>
	state.lens === 'manual'
		? {
				source: 'manual',
				distortion: state.lensDistortion,
				vignetting: state.lensVignetting,
				red: state.lensRed,
				blue: state.lensBlue
			}
		: { source: state.lens };

export const toEdit = (state: EditState): Edit => ({
	lens: lensChoice(state),
	calibration: {
		light: { temperature: state.temperature, tint: state.tint },
		exposure: state.exposure
	},
	rows: state.rows
});
