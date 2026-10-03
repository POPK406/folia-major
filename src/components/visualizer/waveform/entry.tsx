import React from 'react';
import { DEFAULT_WAVEFORM_TUNING } from '../../../types';
import { defineVisualizer } from '../definition';
import { WaveformSettingsPanel } from '../settingsPanels';

const VisualizerWaveform = React.lazy(() => import('./VisualizerWaveform'));

// src/components/visualizer/waveform/entry.tsx
//
// 波环：完全照搬回环（claddagh）的环形版式与视觉，把环上的文字换成 FL 宿主时间轴式的
// 整曲静态波形（预先分析、不播放也在）。播放头钉死在环的正前方（中心线近端，永远正对
// 视角），前半圈是新波形、后半圈是旧波形，新旧在环的正后方交接；环不自转，内容随播放
// 流动。tuning 在回环几何之上另加 detail（细分）/ smoothing（平滑）。

export default defineVisualizer({
    mode: 'waveform',
    order: 85,
    labelKey: 'ui.visualizerWaveform',
    labelFallback: 'Wave Ring',
    previewSeed: 'waveform',
    previewStartOffset: 0,
    tuningKind: 'waveform',
    render: props => <VisualizerWaveform {...props} />,
    renderSettingsPanel: props => <WaveformSettingsPanel {...props} />,
    resetSettings: ({ resetWaveformTuning, setDraftWaveformTuning }) => {
        setDraftWaveformTuning?.(DEFAULT_WAVEFORM_TUNING);
        resetWaveformTuning?.();
    },
});
