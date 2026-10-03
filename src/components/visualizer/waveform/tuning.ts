import { defineVisualizerTuning } from '../tuningRegistry';

// src/components/visualizer/waveform/tuning.ts
//
// 波环的 tuning 走自己的槽位：几何字段与回环同构，另加 detail（细分）与 smoothing（平滑）。

export default defineVisualizerTuning({
    mode: 'waveform',
    settingsKey: 'waveformTuning',
    settingsSetterKey: 'handleSetWaveformTuning',
    apply: (props, tuning) => ({ ...props, waveformTuning: tuning }),
});
