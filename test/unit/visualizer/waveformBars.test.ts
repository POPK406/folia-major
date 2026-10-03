import { describe, expect, it } from 'vitest';
import {
    WAVEFORM_DETAIL_POINT_COUNT,
    WAVEFORM_FLOW_VOLUME_TAU,
    WAVEFORM_JET_MOMENTUM_MAX,
    WAVEFORM_JET_RING_T,
    WAVEFORM_JET_SWAY_PERIOD,
    WAVEFORM_JET_SWAY_RADIANS,
    WAVEFORM_MIN_WINDOW_SECONDS,
    WAVEFORM_POINT_COUNT,
    WAVEFORM_SEEP_ARC_T,
    WAVEFORM_WINDOW_SECONDS,
    WAVEFORM_WINDOW_VOLUME_GAIN,
    WAVEFORM_WINDOW_VOLUME_MIN,
    applyWaveformWindowVolume,
    approachExponential,
    buildWaveformRingAngles,
    resolveWaveformJetMomentum,
    resolveWaveformPointCount,
    resolveWaveformSeepStrength,
    resolveWaveformSmoothingRadiusBins,
    resolveWaveformWindowSeconds,
    sampleStaticWaveformAt,
    smoothPeakEnvelope,
    songTimeAtRingT,
    synthIdleWaveformSample,
    waveformJetSway,
    waveformRingGradientStop,
} from '@/components/visualizer/waveform/waveformBars';

// test/unit/visualizer/waveformBars.test.ts
// 波环的纯计算口径：环上角度分布、整曲静态波形的插值取样、静音兜底，以及
// 「播放头恒定在环正前方、新旧波形在环正后方交接」的环形时间轴映射。
describe('waveform ring helpers', () => {
    it('spaces ring angles evenly around the full ring, starting at -PI', () => {
        const angles = buildWaveformRingAngles(8);

        expect(angles.length).toBe(8);
        expect(angles[0]).toBeCloseTo(-Math.PI, 6);
        expect(angles[1]).toBeCloseTo(-Math.PI + Math.PI / 4, 6);
        expect(angles[7]).toBeCloseTo(-Math.PI + (Math.PI * 7) / 4, 6);
    });

    it('caches the angle table for a given point count', () => {
        expect(buildWaveformRingAngles(12)).toBe(buildWaveformRingAngles(12));
    });

    it('returns zero for missing peaks', () => {
        expect(sampleStaticWaveformAt(null, 0)).toBe(0);
        expect(sampleStaticWaveformAt(new Float32Array(0), 0.5)).toBe(0);
    });

    it('interpolates the static peak envelope and wraps t around the ring', () => {
        const peaks = Float32Array.from([0, 0.5, 1]);

        expect(sampleStaticWaveformAt(peaks, 0)).toBeCloseTo(0, 6);
        expect(sampleStaticWaveformAt(peaks, 1 / 3)).toBeCloseTo(0.5, 6);
        // bin 中点上的线性插值。
        expect(sampleStaticWaveformAt(peaks, 1 / 6)).toBeCloseTo(0.25, 6);
        // t 越界与负值都按整圈回绕：-1/3 → 2/3，即最后一个 bin 的起点。
        expect(sampleStaticWaveformAt(peaks, 1)).toBeCloseTo(0, 6);
        expect(sampleStaticWaveformAt(peaks, -1 / 3)).toBeCloseTo(1, 6);
    });

    it('pins the playhead at the front and hands old over to new at the back', () => {
        const now = 100;
        const window = 20;

        // 正前方恒为「现在」。
        expect(songTimeAtRingT(0, now, window)).toBeCloseTo(now, 6);
        // 前半圈是未来：从现在流向 now+W。
        expect(songTimeAtRingT(0.25, now, window)).toBeCloseTo(now + 10, 6);
        // 正后方是交接点：未来侧的末端是 now+W。
        expect(songTimeAtRingT(0.5, now, window)).toBeCloseTo(now + 20, 6);
        // 后半圈是过去：从 now-W 流回现在。
        expect(songTimeAtRingT(0.75, now, window)).toBeCloseTo(now - 10, 6);
        expect(songTimeAtRingT(1, now, window)).toBeCloseTo(now, 6);
        // 交接点两侧：最旧的已播（now-W）与最新的未播（now+W）在同一处相遇。
        expect(songTimeAtRingT(0.5 - 1e-9, now, window)).toBeCloseTo(now + 20, 6);
        expect(songTimeAtRingT(0.5 + 1e-9, now, window)).toBeCloseTo(now - 20, 6);
        // 越界 ringT 按整圈回绕。
        expect(songTimeAtRingT(-0.25, now, window)).toBeCloseTo(now - 10, 6);
        expect(songTimeAtRingT(1.25, now, window)).toBeCloseTo(now + 10, 6);
    });

    it('shrinks the window for short songs so the ring stays full', () => {
        expect(resolveWaveformWindowSeconds(300)).toBe(WAVEFORM_WINDOW_SECONDS);
        expect(resolveWaveformWindowSeconds(0)).toBe(WAVEFORM_WINDOW_SECONDS);
        expect(resolveWaveformWindowSeconds(-5)).toBe(WAVEFORM_WINDOW_SECONDS);
        // 半圈只分到 duration/2：整首歌恰好铺满一圈。
        expect(resolveWaveformWindowSeconds(20)).toBeCloseTo(10, 6);
        // 但不许缩到看不清。
        expect(resolveWaveformWindowSeconds(4)).toBe(WAVEFORM_MIN_WINDOW_SECONDS);
    });

    it('tightens the window with volume, so content flows past the playhead faster when loud', () => {
        // 安静：比基准稍宽（流速慢一点）。
        expect(applyWaveformWindowVolume(18, 0)).toBeCloseTo(18 / WAVEFORM_WINDOW_VOLUME_MIN, 6);
        // 最响：明显收窄（流速快约 1.65 倍）。
        expect(applyWaveformWindowVolume(18, 1)).toBeCloseTo(18 / (WAVEFORM_WINDOW_VOLUME_MIN + WAVEFORM_WINDOW_VOLUME_GAIN), 6);
        // 音量单调收窄窗口（速度单调加快）。
        const quiet = applyWaveformWindowVolume(18, 0.2);
        const loud = applyWaveformWindowVolume(18, 0.8);
        expect(loud).toBeLessThan(quiet);
        // 越界音量按端点处理。
        expect(applyWaveformWindowVolume(18, -1)).toBeCloseTo(applyWaveformWindowVolume(18, 0), 6);
        expect(applyWaveformWindowVolume(18, 2)).toBeCloseTo(applyWaveformWindowVolume(18, 1), 6);
    });

    it('anchors the tide vector at the lower-right end of the centre axis (the playhead)', () => {
        // 中心轴线偏右下那一端就是 ringT = 0（播放头 /「现在」），位置与方向都不随歌曲时间变。
        expect(WAVEFORM_JET_RING_T).toBe(0);
    });

    it('scales the vector momentum by decibels and frequency', () => {
        // 静音 → 0。
        expect(resolveWaveformJetMomentum(0, 0)).toBe(0);
        expect(resolveWaveformJetMomentum(0, 1)).toBe(0);
        // 越响、低频越足，动量越大。
        expect(resolveWaveformJetMomentum(0.5, 0)).toBeLessThan(resolveWaveformJetMomentum(1, 0));
        expect(resolveWaveformJetMomentum(1, 0)).toBeLessThan(resolveWaveformJetMomentum(1, 1));
        // 满响 + 满低频就是满动量，整体倍率 0.6（锚点不动之后推力是唯一水动力源）。
        expect(resolveWaveformJetMomentum(1, 1)).toBeCloseTo(WAVEFORM_JET_MOMENTUM_MAX, 6);
        expect(WAVEFORM_JET_MOMENTUM_MAX).toBe(0.6);
        // 越界输入按端点处理。
        expect(resolveWaveformJetMomentum(2, 2)).toBeCloseTo(resolveWaveformJetMomentum(1, 1), 6);
        expect(resolveWaveformJetMomentum(-1, 1)).toBe(0);
    });

    it('sways the vector direction slowly inside its amplitude band', () => {
        // 幅度：永远不超过 ±20°。
        for (let step = 0; step <= 64; step += 1) {
            const angle = waveformJetSway((step / 64) * WAVEFORM_JET_SWAY_PERIOD);
            expect(Math.abs(angle)).toBeLessThanOrEqual(WAVEFORM_JET_SWAY_RADIANS + 1e-9);
        }
        // 四分之一周期到正向极值，半周期回零，四分之三周期到负向极值，整周期回到原点。
        expect(waveformJetSway(0)).toBeCloseTo(0, 6);
        expect(waveformJetSway(WAVEFORM_JET_SWAY_PERIOD / 4)).toBeCloseTo(WAVEFORM_JET_SWAY_RADIANS, 6);
        expect(waveformJetSway(WAVEFORM_JET_SWAY_PERIOD / 2)).toBeCloseTo(0, 6);
        expect(waveformJetSway(WAVEFORM_JET_SWAY_PERIOD * 0.75)).toBeCloseTo(-WAVEFORM_JET_SWAY_RADIANS, 6);
        expect(waveformJetSway(WAVEFORM_JET_SWAY_PERIOD)).toBeCloseTo(0, 6);
    });

    it('seeps the lower arc at fixed ring positions, staying under the playhead vector', () => {
        // 渗染点固定落在环的下半弧（ringT 0.5~1 那一侧），不随歌曲时间绕圈跑。
        for (const ringT of WAVEFORM_SEEP_ARC_T) {
            expect(ringT).toBeGreaterThan(0.5);
            expect(ringT).toBeLessThan(1);
        }
        // 强度随振幅增减，但上限压在播放头（0.6 起）之下。
        expect(resolveWaveformSeepStrength(0)).toBeCloseTo(0.18, 6);
        expect(resolveWaveformSeepStrength(1)).toBeCloseTo(0.58, 6);
        expect(resolveWaveformSeepStrength(1)).toBeLessThan(0.6);
        expect(resolveWaveformSeepStrength(0.5)).toBeGreaterThan(resolveWaveformSeepStrength(0));
        expect(resolveWaveformSeepStrength(2)).toBeCloseTo(resolveWaveformSeepStrength(1), 6);
    });

    it('cycles the ring gradient across the palette and closes the loop seamlessly', () => {
        const palette = ['#ff0000', '#00ff00', '#0000ff'];
        // t=0 落在第一段起点。
        expect(waveformRingGradientStop(palette, 0)).toEqual({ from: '#ff0000', to: '#00ff00', amount: 0 });
        // 1/6 = 半段：正好混到一半。
        expect(waveformRingGradientStop(palette, 1 / 6).amount).toBeCloseTo(0.5, 6);
        // 第二段内部：从绿混向蓝（不断言具体比例 —— 段边界附近有浮点误差，但颜色是连续的）。
        const second = waveformRingGradientStop(palette, 0.34);
        expect(second.from).toBe('#00ff00');
        expect(second.to).toBe('#0000ff');
        expect(second.amount).toBeGreaterThan(0);
        expect(second.amount).toBeLessThan(0.2);
        // 末尾接回第一个色（闭合），所以 t=1 与 t=0 完全一致 —— 环上没有接缝。
        expect(waveformRingGradientStop(palette, 1)).toEqual(waveformRingGradientStop(palette, 0));
        // 负值按环回绕，等价于 +5/6。
        const wrappedNegative = waveformRingGradientStop(palette, -1 / 6);
        const wrappedPositive = waveformRingGradientStop(palette, 5 / 6);
        expect(wrappedNegative.from).toBe(wrappedPositive.from);
        expect(wrappedNegative.to).toBe(wrappedPositive.to);
        expect(wrappedNegative.amount).toBeCloseTo(wrappedPositive.amount, 6);
    });

    it('degrades the ring gradient to a single colour when the palette is short', () => {
        expect(waveformRingGradientStop([], 0.3)).toEqual({ from: '#ffffff', to: '#ffffff', amount: 0 });
        expect(waveformRingGradientStop(['#123456'], 0.3)).toEqual({ from: '#123456', to: '#123456', amount: 0 });
    });

    it('keeps the idle wave small but alive', () => {
        for (let step = 0; step <= 32; step += 1) {
            const value = synthIdleWaveformSample(step / 32, 3.2);
            expect(Math.abs(value)).toBeLessThanOrEqual(0.2);
        }
        expect(synthIdleWaveformSample(0, 0)).not.toBeCloseTo(synthIdleWaveformSample(0, 1.7), 6);
    });

    it('maps the detail presets to increasing ring sampling density', () => {
        expect(resolveWaveformPointCount('low')).toBe(WAVEFORM_DETAIL_POINT_COUNT.low);
        expect(resolveWaveformPointCount('standard')).toBe(WAVEFORM_DETAIL_POINT_COUNT.standard);
        expect(resolveWaveformPointCount('fine')).toBe(WAVEFORM_DETAIL_POINT_COUNT.fine);
        expect(resolveWaveformPointCount('low')).toBeLessThan(resolveWaveformPointCount('fine'));
        // 未知/缺省档位回落到 standard。
        expect(resolveWaveformPointCount(undefined)).toBe(WAVEFORM_POINT_COUNT);
        expect(resolveWaveformPointCount('nonsense' as never)).toBe(WAVEFORM_POINT_COUNT);
    });

    it('grows the smoothing radius with the setting and clamps it', () => {
        expect(resolveWaveformSmoothingRadiusBins(0, 16384)).toBe(0);
        expect(resolveWaveformSmoothingRadiusBins(1, 16384)).toBeGreaterThan(0);
        expect(resolveWaveformSmoothingRadiusBins(0.5, 16384))
            .toBeLessThan(resolveWaveformSmoothingRadiusBins(1, 16384));
        // 越界按端点处理。
        expect(resolveWaveformSmoothingRadiusBins(-1, 16384)).toBe(resolveWaveformSmoothingRadiusBins(0, 16384));
        expect(resolveWaveformSmoothingRadiusBins(2, 16384)).toBe(resolveWaveformSmoothingRadiusBins(1, 16384));
        expect(resolveWaveformSmoothingRadiusBins(Number.NaN, 16384)).toBe(0);
        // 半径是「峰值序列」的比例，与环上采样点数无关：整曲 0.35% 是弧内 ~0.8s 的柔化。
        expect(resolveWaveformSmoothingRadiusBins(1, 16384)).toBe(57);
    });

    it('pre-smooths the peak envelope once, clamping at the song ends (no wrap)', () => {
        const source = Float32Array.from([0, 0, 1, 0, 0]);
        const out = new Float32Array(5);

        // 半径 0：原样拷贝。
        smoothPeakEnvelope(source, 0, out);
        expect(Array.from(out)).toEqual([0, 0, 1, 0, 0]);

        // 半径 1：每个点是自身与左右邻居的平均。
        smoothPeakEnvelope(source, 1, out);
        expect(out[2]).toBeCloseTo(1 / 3, 6);
        expect(out[1]).toBeCloseTo(1 / 3, 6);
        expect(out[0]).toBeCloseTo(0, 6);

        // 两端夹紧：窗口不会绕到另一头，所以首尾不会被对侧的峰值污染。
        const edges = Float32Array.from([1, 0, 0, 0, 1]);
        smoothPeakEnvelope(edges, 2, out);
        expect(out[0]).toBeCloseTo(1 / 3, 6);
        expect(out[4]).toBeCloseTo(1 / 3, 6);
        expect(out[2]).toBeCloseTo((1 + 1) / 5, 6);

        // 长序列里的孤立尖峰：被摊平成一根平顶，峰值降到 1/(2r+1)。
        const long = new Float32Array(33);
        long[16] = 1;
        const longOut = new Float32Array(33);
        smoothPeakEnvelope(long, 2, longOut);
        expect(longOut[16]).toBeCloseTo(1 / 5, 6);
        expect(longOut[14]).toBeCloseTo(1 / 5, 6);
        expect(longOut[13]).toBeCloseTo(0, 6);
        expect(Math.max(...longOut)).toBeCloseTo(1 / 5, 6);
    });

    it('approaches the target exponentially so a jittery signal becomes phrase-level', () => {
        // dt 等于时间常数时走完约 63%。
        expect(approachExponential(0, 1, WAVEFORM_FLOW_VOLUME_TAU, WAVEFORM_FLOW_VOLUME_TAU))
            .toBeCloseTo(1 - Math.exp(-1), 6);
        // 一个来回跳动的音量：慢滤波的输出幅度远小于输入，且单调趋近。
        let value = 0.5;
        const targets = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
        let max = value;
        let min = value;
        for (const target of targets) {
            value = approachExponential(value, target, 1 / 60, WAVEFORM_FLOW_VOLUME_TAU);
            max = Math.max(max, value);
            min = Math.min(min, value);
        }
        expect(max - min).toBeLessThan(0.06);
        // tau <= 0（或非法值）直接吸附目标，退出时不残留。
        expect(approachExponential(0.2, 0.9, 1 / 60, 0)).toBe(0.9);
        expect(approachExponential(0.2, 0.9, 1 / 60, Number.NaN)).toBe(0.9);
        // dt 为 0 时不动。
        expect(approachExponential(0.2, 0.9, 0, 1)).toBeCloseTo(0.2, 6);
    });
});
