import { DEFAULT_WAVEFORM_TUNING, type WaveformDetail, type WaveformTuning } from '../types';

// src/utils/waveformTuning.ts
// 波环 tuning 的归一化：localStorage、同步、外观短码 / JSON 导入和 store setter 共用同一套钳制规则。

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => (
    typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : fallback
);

const pickBoolean = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

const DETAILS: readonly WaveformDetail[] = ['low', 'standard', 'fine'];

/**
 * 把任意输入收敛成合法的 WaveformTuning：数值钳到各自区间，缺失或类型不对的字段回落到默认值，
 * 枚举只认已知取值。输入不是对象时直接返回默认值。
 */
export const normalizeWaveformTuning = (value: unknown): WaveformTuning => {
    const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const d = DEFAULT_WAVEFORM_TUNING;
    return {
        focusScaleRatio: clampNumber(raw.focusScaleRatio, d.focusScaleRatio, 0, 1.5),
        radiusScale: clampNumber(raw.radiusScale, d.radiusScale, 0.5, 1.5),
        ellipseTiltDeg: clampNumber(raw.ellipseTiltDeg, d.ellipseTiltDeg, 0, 60),
        showAxisLine: pickBoolean(raw.showAxisLine, d.showAxisLine),
        letterSpacingOffset: clampNumber(raw.letterSpacingOffset, d.letterSpacingOffset, -5, 20),
        detail: DETAILS.includes(raw.detail as WaveformDetail)
            ? raw.detail as WaveformDetail
            : d.detail,
        smoothing: clampNumber(raw.smoothing, d.smoothing, 0, 1),
        beatImpact: clampNumber(raw.beatImpact, d.beatImpact, 0, 2),
        beatAttack: clampNumber(raw.beatAttack, d.beatAttack, 0, 0.5),
        beatDecay: clampNumber(raw.beatDecay, d.beatDecay, 0.05, 1.2),
        beatExpand: clampNumber(raw.beatExpand, d.beatExpand, 0, 1.5),
        beatPerspective: clampNumber(raw.beatPerspective, d.beatPerspective, 0, 1.5),
        beatSensitivity: clampNumber(raw.beatSensitivity, d.beatSensitivity, 0.3, 3),
    };
};
