import { describe, expect, it } from 'vitest';
import { DEFAULT_WAVEFORM_TUNING } from '@/types';
import { normalizeWaveformTuning } from '@/utils/waveformTuning';

// test/unit/visualizer/waveformTuning.test.ts
// 波环 tuning 的归一化契约：localStorage、同步、外观短码与 Folium 共用这一套钳制。
describe('normalizeWaveformTuning', () => {
    it('falls back to the defaults for non-object input', () => {
        expect(normalizeWaveformTuning(null)).toEqual(DEFAULT_WAVEFORM_TUNING);
        expect(normalizeWaveformTuning('nonsense')).toEqual(DEFAULT_WAVEFORM_TUNING);
        expect(normalizeWaveformTuning(42)).toEqual(DEFAULT_WAVEFORM_TUNING);
    });

    it('clamps every numeric field to its own range', () => {
        const tuner = normalizeWaveformTuning({
            focusScaleRatio: 9,
            radiusScale: 9,
            ellipseTiltDeg: 90,
            letterSpacingOffset: 99,
            smoothing: 5,
            beatImpact: 9,
            beatAttack: 9,
            beatDecay: 9,
            beatExpand: 9,
            beatPerspective: 9,
            beatSensitivity: 9,
        });
        expect(tuner.focusScaleRatio).toBe(1.5);
        expect(tuner.radiusScale).toBe(1.5);
        expect(tuner.ellipseTiltDeg).toBe(60);
        expect(tuner.letterSpacingOffset).toBe(20);
        expect(tuner.smoothing).toBe(1);
        expect(tuner.beatImpact).toBe(2);
        expect(tuner.beatAttack).toBe(0.5);
        expect(tuner.beatDecay).toBe(1.2);
        expect(tuner.beatExpand).toBe(1.5);
        expect(tuner.beatPerspective).toBe(1.5);
        expect(tuner.beatSensitivity).toBe(3);

        const under = normalizeWaveformTuning({
            focusScaleRatio: -9,
            radiusScale: -9,
            ellipseTiltDeg: -9,
            letterSpacingOffset: -99,
            smoothing: -9,
            beatImpact: -9,
            beatAttack: -9,
            beatDecay: -9,
            beatExpand: -9,
            beatPerspective: -9,
            beatSensitivity: -9,
        });
        expect(under.focusScaleRatio).toBe(0);
        expect(under.radiusScale).toBe(0.5);
        expect(under.ellipseTiltDeg).toBe(0);
        expect(under.letterSpacingOffset).toBe(-5);
        expect(under.smoothing).toBe(0);
        expect(under.beatImpact).toBe(0);
        expect(under.beatAttack).toBe(0);
        expect(under.beatDecay).toBe(0.05);
        expect(under.beatExpand).toBe(0);
        expect(under.beatPerspective).toBe(0);
        expect(under.beatSensitivity).toBe(0.3);
    });

    it('only accepts known detail presets and keeps booleans typed', () => {
        expect(normalizeWaveformTuning({ detail: 'fine' }).detail).toBe('fine');
        expect(normalizeWaveformTuning({ detail: 'low' }).detail).toBe('low');
        expect(normalizeWaveformTuning({ detail: 'nonsense' }).detail).toBe(DEFAULT_WAVEFORM_TUNING.detail);
        expect(normalizeWaveformTuning({}).detail).toBe(DEFAULT_WAVEFORM_TUNING.detail);

        expect(normalizeWaveformTuning({ showAxisLine: false }).showAxisLine).toBe(false);
        expect(normalizeWaveformTuning({ showAxisLine: 'yes' }).showAxisLine).toBe(DEFAULT_WAVEFORM_TUNING.showAxisLine);
    });

    it('treats non-finite numbers as missing rather than propagating NaN', () => {
        const tuner = normalizeWaveformTuning({
            smoothing: Number.NaN,
            beatImpact: Number.POSITIVE_INFINITY,
            radiusScale: Number.NEGATIVE_INFINITY,
        });
        expect(tuner.smoothing).toBe(DEFAULT_WAVEFORM_TUNING.smoothing);
        expect(tuner.beatImpact).toBe(DEFAULT_WAVEFORM_TUNING.beatImpact);
        expect(tuner.radiusScale).toBe(DEFAULT_WAVEFORM_TUNING.radiusScale);
    });
});
