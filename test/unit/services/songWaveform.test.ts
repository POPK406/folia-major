import { describe, expect, it } from 'vitest';
import { SONG_WAVEFORM_BINS, buildWaveformPeaks } from '@/services/songWaveform';

// test/unit/services/songWaveform.test.ts
// 整曲静态波形（FL 预制式）的峰值降采样口径：bin 数、每 bin 峰值、整曲归一化。
describe('buildWaveformPeaks', () => {
    it('returns all-zero peaks for empty input', () => {
        const peaks = buildWaveformPeaks(new Float32Array(0), SONG_WAVEFORM_BINS);
        expect(peaks.length).toBe(SONG_WAVEFORM_BINS);
        expect(Math.max(...peaks)).toBe(0);
    });

    it('takes the loudest sample in each bin', () => {
        // 4 个 bin，每 bin 4 个样本：峰值应为 0.1 / 0.4 / 0.3 / 0.2。
        const samples = Float32Array.from([
            0.1, -0.05, 0.02, -0.1,
            -0.4, 0.3, -0.2, 0.1,
            0.3, -0.25, 0.1, 0.05,
            -0.05, 0.2, -0.15, 0.1,
        ]);
        const peaks = buildWaveformPeaks(samples, 4);
        expect(Array.from(peaks)).toEqual([0.25, 1, 0.75, 0.5]);
    });

    it('normalises against the loudest bin, so the result is 0..1 with a peak of 1', () => {
        const samples = Float32Array.from([0.2, -0.6, 0.1, 0.3]);
        const peaks = buildWaveformPeaks(samples, 2);
        expect(peaks[0]).toBeCloseTo(1, 6);
        expect(peaks[1]).toBeCloseTo(0.5, 6);
    });

    it('leaves silence as zeros instead of dividing by zero', () => {
        const peaks = buildWaveformPeaks(new Float32Array(64), 8);
        expect(Math.max(...peaks)).toBe(0);
    });

    it('produces the documented bin count for a full-size input', () => {
        const samples = new Float32Array(22050 * 10);
        const peaks = buildWaveformPeaks(samples, SONG_WAVEFORM_BINS);
        expect(peaks.length).toBe(SONG_WAVEFORM_BINS);
    });
});
