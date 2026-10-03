// src/components/visualizer/waveform/waveformBars.ts
//
// 波环的纯计算部分：环上角度表、整曲静态波形的插值取样、静音兜底，以及
// 「播放头恒定在环正前方、新旧波形在环正后方交接」的环形时间轴映射。
// 不依赖 React，renderer、预览和单测共用同一套口径。

import type { WaveformDetail } from '../../../types';

/**
 * 环上波形的采样点数（按细分档位）。越密越接近 FL 宿主时间轴那种「密到发糊」的
 * 连续线性波形；canvas 描线对点数不敏感，这里只受视觉密度与性能约束。
 */
export const WAVEFORM_DETAIL_POINT_COUNT: Record<WaveformDetail, number> = {
    low: 480,
    standard: 960,
    fine: 1920,
};
/** 默认（standard）档的采样点数，给不传档位的地方用。 */
export const WAVEFORM_POINT_COUNT = WAVEFORM_DETAIL_POINT_COUNT.standard;

/** 细分档位 → 采样点数。未知档位回落到 standard。 */
export const resolveWaveformPointCount = (detail: WaveformDetail | undefined): number =>
    WAVEFORM_DETAIL_POINT_COUNT[detail ?? 'standard'] ?? WAVEFORM_POINT_COUNT;

/** 环的短轴 / 长轴比例：回环式的扁环。几何是纯椭圆，没有任何透视压缩。 */
export const WAVEFORM_RING_MINOR_RATIO = 0.24;

/** 波形振幅相对环长轴的最大比例。 */
export const WAVEFORM_AMPLITUDE_RATIO = 0.22;

/**
 * 波形平滑：对**整曲峰值序列**做一次滑动平均（在分析/显示时算一次，绝不逐帧算）。
 *
 * 半径按峰值 bin 数的比例给（与歌曲时长无关）：满档约为整曲长度的 0.35%，
 * 对四五分钟的歌约等于 ~0.8s 的柔化，正是 FL 时间轴那种圆润包络。
 */
export const WAVEFORM_SMOOTHING_MAX_RADIUS_RATIO = 0.0035;
export const resolveWaveformSmoothingRadiusBins = (
    smoothing: number,
    peakCount: number,
): number => {
    const safe = Number.isFinite(smoothing) ? Math.min(1, Math.max(0, smoothing)) : 0;
    return Math.round(safe * WAVEFORM_SMOOTHING_MAX_RADIUS_RATIO * peakCount);
};

/**
 * 环形时间轴的窗口：前半圈（未来/新波形）与后半圈（过去/旧波形）各显示这么长的一段。
 * 整个环是「当前时刻 ± 窗口」的滑动窗口 —— 播放头钉在环的正前方不动，
 * 波形内容随播放流过环面，窗口的两端（最旧的已播 / 最新的未播）在环的正后方交接。
 */
export const WAVEFORM_WINDOW_SECONDS = 18;
/** 短歌收缩窗口的下限：太窄的话波形就只剩几个点。 */
export const WAVEFORM_MIN_WINDOW_SECONDS = 6;

/**
 * 音量 → 流速：越响窗口越窄，同样的播放进度下内容流过播放头的速度越快
 * （安静 ~21s 窗口 / 最响 ~13s 窗口，流速差约 1.65 倍）。播放头处的时间轴始终
 * 对齐 currentTime，变的只是「变焦」，所以不会错位。
 *
 * 注意：窗口会重映射环上每一个点，所以**不能**用逐帧跳动的瞬时音量去算它 ——
 * 那样整条波形会随分贝来回抽动。调用方必须先把音量按 FLOW_VOLUME_TAU 平滑成
 * 「乐句级」的缓慢动态，再喂进来。
 */
export const WAVEFORM_WINDOW_VOLUME_MIN = 0.85;
export const WAVEFORM_WINDOW_VOLUME_GAIN = 0.55;
export const applyWaveformWindowVolume = (windowSeconds: number, normalizedVolume: number): number =>
    windowSeconds / (WAVEFORM_WINDOW_VOLUME_MIN + WAVEFORM_WINDOW_VOLUME_GAIN * clamp01(normalizedVolume));

/** 用于「变焦/膨胀」这类几何量的音量平滑时间常数（秒）：把抖动信号变成缓慢的乐句动态。 */
export const WAVEFORM_FLOW_VOLUME_TAU = 1.6;

/**
 * 指数趋近：时间常数 tau 秒内走完约 63%。用于把音量这类逐帧抖动的信号
 * 变成平滑的乐句级动态；tau <= 0 时直接取目标值。
 */
export const approachExponential = (
    current: number,
    target: number,
    dt: number,
    tau: number,
): number => {
    if (!Number.isFinite(tau) || tau <= 0) return target;
    const alpha = 1 - Math.exp(-Math.max(0, dt) / tau);
    return current + (target - current) * alpha;
};

/**
 * 交界向量：落在中心轴线偏右下那一端（ringT = 0，也就是播放头 /「现在」那一点）。
 * 方向沿环在该处的切向、取朝斜左下的一支；动量由「分贝 × 频率」决定。
 *
 * 位置固定、方向固定，只有动量随音乐起伏：水面拿到的是一股有方向、会随音乐变强变弱的「涌」。
 * 这股向量挂在播放头标记上（同一位置再单开一个标记会让该处染料翻倍）。
 */
export const WAVEFORM_JET_RING_T = 0;
/** 推力上限：整股向量的「大小区间倍率」，调小就整体弱一点（0 等于关掉这股推水）。 */
export const WAVEFORM_JET_MOMENTUM_MAX = 0.6;
/**
 * 动量 = 分贝 × 频率：分贝是整体响度，频率项是频段能量（低频越足越像「涌」）。
 * 两者相乘得到 0..1，再乘上限就是喂给 tide 的推力大小 —— 静音归零，越响、低频越猛，推得越狠。
 */
export const resolveWaveformJetMomentum = (loudness: number, bandEnergy: number): number =>
    clamp01(loudness) * (0.3 + 0.7 * clamp01(bandEnergy)) * WAVEFORM_JET_MOMENTUM_MAX;

/** 方向慢摆：±32°，周期约 7s —— 让水流从「一条直线推」变成「一边搅动一边推」。 */
export const WAVEFORM_JET_SWAY_RADIANS = (32 * Math.PI) / 180;
export const WAVEFORM_JET_SWAY_PERIOD = 7;
export const waveformJetSway = (time: number): number =>
    WAVEFORM_JET_SWAY_RADIANS * Math.sin((time / WAVEFORM_JET_SWAY_PERIOD) * Math.PI * 2);

/**
 * 低频起音叠给推力的脉冲：前摇 0.06s、回落 0.5s。推力是脉冲式的（0 与 1 之间），
 * 回落故意放长：推力在 tide 侧要被采样 + 淡入各磨一遍，太短的脉冲会被直接抹平。
 */
export const WAVEFORM_JET_PULSE_ATTACK = 0.06;
export const WAVEFORM_JET_PULSE_DECAY = 0.5;

/**
 * 环下半弧的渗染点（ringT）：在环底部固定的一小段上一起渗染料，读作「环在渗」，
 * 而不是一个点在推。它们只出染料、不带方向推力（推水仍只由播放头那一股向量负责）。
 */
export const WAVEFORM_SEEP_ARC_T = [0.66, 0.75, 0.84] as const;
/** 渗染点强度：随该处波形振幅增减；上限压低，免得盖过播放头那股向量。 */
export const resolveWaveformSeepStrength = (amplitude: number): number =>
    0.18 + 0.4 * clamp01(amplitude);

/** 环上渐变色标：一次取样要的两个端点色与混合比例。 */
export interface WaveformGradientStop {
    from: string;
    to: string;
    amount: number;
}

/**
 * 环上渐变色标：沿整圈在 palette 里循环取样（末尾自动接回第一个色，所以 t=0/1 处无接缝）。
 * palette 少于 2 个色时退化为单色。调用方拿 from/to/amount 交给 mixColors 混色 ——
 * 这个函数只负责「t 落在哪一段色标的什么位置」，不碰颜色运算，方便单测。
 */
export const waveformRingGradientStop = (
    palette: readonly string[],
    t: number,
): WaveformGradientStop => {
    if (palette.length === 0) {
        return { from: '#ffffff', to: '#ffffff', amount: 0 };
    }
    if (palette.length === 1) {
        return { from: palette[0], to: palette[0], amount: 0 };
    }

    const wrapped = ((t % 1) + 1) % 1;
    const scaled = wrapped * palette.length;
    const index = Math.floor(scaled) % palette.length;
    return {
        from: palette[index],
        to: palette[(index + 1) % palette.length],
        amount: scaled - Math.floor(scaled),
    };
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

let cachedAngles: Float32Array | null = null;
let cachedAngleCount = 0;

/** 环上等距极角（θ ∈ [-π, π)，θ=0 为环的正前方），缓存避免每帧重建。 */
export const buildWaveformRingAngles = (count: number = WAVEFORM_POINT_COUNT): Float32Array => {
    if (cachedAngles && cachedAngleCount === count) {
        return cachedAngles;
    }

    const angles = new Float32Array(count);
    const step = (Math.PI * 2) / count;
    for (let index = 0; index < count; index += 1) {
        angles[index] = -Math.PI + step * index;
    }

    cachedAngles = angles;
    cachedAngleCount = count;
    return angles;
};

/**
 * 在整曲静态波形的峰值序列里按归一化时间 t∈[0,1) 取插值振幅（0..1）。
 * 相邻 bin 线性插值，t 越界按环回绕；空序列返回 0。
 */
export const sampleStaticWaveformAt = (
    peaks: Float32Array | null | undefined,
    t: number,
): number => {
    if (!peaks || peaks.length === 0) return 0;

    const wrapped = ((t % 1) + 1) % 1;
    const scaled = wrapped * peaks.length;
    const index0 = Math.floor(scaled) % peaks.length;
    const index1 = (index0 + 1) % peaks.length;
    const fraction = scaled - Math.floor(scaled);
    return peaks[index0] + (peaks[index1] - peaks[index0]) * fraction;
};

/**
 * 窗口大小：整曲短于两个窗口就收缩到 duration/2，让短歌也能恰好铺满整圈；
 * 没有时长信息（还没加载）就用满额窗口。
 */
export const resolveWaveformWindowSeconds = (durationSeconds: number): number => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return WAVEFORM_WINDOW_SECONDS;
    return Math.max(WAVEFORM_MIN_WINDOW_SECONDS, Math.min(WAVEFORM_WINDOW_SECONDS, durationSeconds / 2));
};

/**
 * 环上位置 → 歌曲时间。这是环形时间轴的核心约定：
 *
 * - ringT = 0 恒为「现在」（播放头），钉在环的正前方，永远正对视角；
 * - ringT ∈ (0, 0.5] 是未来（新波形）：从正前方沿环流向正后方，时间 = now + ringT·2W；
 * - ringT ∈ (0.5, 1) 是过去（旧波形）：从正后方流回正前方，时间 = now − (1−ringT)·2W；
 * - ringT = 0.5 恒为交接点：最旧的已播波形（now−W）在这里让位给最新的未播波形（now+W）。
 */
export const songTimeAtRingT = (
    ringT: number,
    nowSeconds: number,
    windowSeconds: number,
): number => {
    const wrapped = ((ringT % 1) + 1) % 1;
    if (wrapped <= 0.5) {
        return nowSeconds + wrapped * 2 * windowSeconds;
    }
    return nowSeconds - (1 - wrapped) * 2 * windowSeconds;
};

/** 波形还没分析出来（或这首歌拿不到）时的兜底：低幅、缓慢起伏，环保持活性。 */
export const synthIdleWaveformSample = (ringT: number, time: number): number =>
    0.10 * Math.sin(ringT * Math.PI * 2 * 3 + time * 0.9)
    + 0.05 * Math.sin(ringT * Math.PI * 2 * 7 - time * 1.4);

/**
 * 对整曲峰值序列做一次滑动平均，结果写进 `out`（与输入等长）；半径 0 时直接拷贝。
 *
 * 两端**夹紧**而不是环绕：歌曲不是闭环，环绕会把结尾抹到开头。这个函数只在
 * peaks 或平滑设置变化时跑一次（见渲染层的 useMemo），帧循环里绝不再调用 ——
 * 逐帧做 O(count × radius) 的卷积会掉帧，而掉帧的内容位置是离散跳变的，那才抽搐。
 */
export const smoothPeakEnvelope = (
    source: Float32Array,
    radiusBins: number,
    out: Float32Array,
): void => {
    const count = source.length;
    if (count === 0) return;
    if (radiusBins <= 0) {
        out.set(source);
        return;
    }

    // 前缀和 → 每个窗口 O(1)，整体 O(count)：拖动平滑滑杆时重算也只是一次线性扫描。
    const prefix = new Float64Array(count + 1);
    for (let index = 0; index < count; index += 1) {
        prefix[index + 1] = prefix[index] + source[index];
    }

    for (let index = 0; index < count; index += 1) {
        const start = Math.max(0, index - radiusBins);
        const end = Math.min(count - 1, index + radiusBins);
        out[index] = (prefix[end + 1] - prefix[start]) / (end - start + 1);
    }
};
