import React from 'react';
import { motionValue } from 'framer-motion';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME } from '@/services/baseThemes';
import VisualizerWaveform from '@/components/visualizer/waveform/VisualizerWaveform';

// test/unit/visualizer/waveformMode.test.ts
// 波环契约：画面上是贴着环滚动的连续波形 canvas，且不挂任何歌词/翻译文本层。
vi.mock('@/components/visualizer/backgrounds/VisualizerBackgroundRenderer', () => ({
    default: () => React.createElement('div', { 'data-testid': 'background-renderer' }),
}));
vi.mock('@/components/visualizer/VisualizerHarmonyOverlay', () => ({
    default: () => React.createElement('div', { 'data-testid': 'harmony-overlay' }),
}));

const createAudioBands = () => ({
    bass: motionValue(0),
    lowMid: motionValue(0),
    mid: motionValue(0),
    vocal: motionValue(0),
    treble: motionValue(0),
    waveform: motionValue(new Uint8Array(0)),
});

const renderWaveform = (overrides: Record<string, unknown> = {}) => {
    const markup = renderToStaticMarkup(React.createElement(VisualizerWaveform, {
        currentTime: motionValue(0),
        currentLineIndex: 0,
        lines: [{
            startTime: 0,
            endTime: 1,
            fullText: 'HELLO WORLD',
            words: [{ text: 'HELLO WORLD', startTime: 0, endTime: 1 }],
        }],
        theme: DEFAULT_THEME,
        audioPower: motionValue(0),
        audioBands: createAudioBands(),
        ...overrides,
    } as never));

    return markup;
};

describe('VisualizerWaveform', () => {
    it('renders the ring waveform canvas instead of lyric text', () => {
        const markup = renderWaveform();

        expect(markup).toContain('data-waveform-canvas');
        expect(markup).not.toContain('HELLO');
        expect(markup).not.toContain('WORLD');
    });

    it('drops the waveform canvas when lyrics are hidden', () => {
        expect(renderWaveform({ showText: false })).not.toContain('data-waveform-canvas');
    });

    it('keeps the claddagh-style axis line available', () => {
        expect(renderWaveform()).toContain('300px');
    });
});
