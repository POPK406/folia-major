// Only for the you who has yet to exist in this world.
// DO NOT REMOVE THE LINE ABOVE.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useSpring } from 'framer-motion';
import { DEFAULT_WAVEFORM_TUNING } from '../../../types';
import { type VisualizerSharedProps } from '../definition';
import { colorWithAlpha, mixColors } from '../colorMix';
import VisualizerShell from '../VisualizerShell';
import { selectDisplaySong, usePlaybackStore } from '../../../stores/usePlaybackStore';
import { ensureSongWaveform } from '../../../services/songWaveform';
import { type BandOnsetTracker, createBandOnsetTracker, stepBandOnsetTracker, stepEnvelopeToward } from '../bandOnsetTracker';
import {
    WAVEFORM_AMPLITUDE_RATIO,
    WAVEFORM_FLOW_VOLUME_TAU,
    WAVEFORM_JET_PULSE_ATTACK,
    WAVEFORM_JET_PULSE_DECAY,
    WAVEFORM_JET_RING_T,
    WAVEFORM_RING_MINOR_RATIO,
    WAVEFORM_SEEP_ARC_T,
    applyWaveformWindowVolume,
    approachExponential,
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
} from './waveformBars';

// src/components/visualizer/waveform/VisualizerWaveform.tsx
//
// 波环（Wave Ring）：FL 宿主时间轴那种「整首歌预先生成的静态波形」，贴在一个回环式的
// 倾斜扁椭圆环上。环形时间轴的约定：
//
// - 播放头（「现在」）钉死在环的正前方 —— 恰好落在中心轴线的近端上，永远正对视角；
// - 前半圈是未来（新波形，正对着你逼近），后半圈是过去（旧波形，向身后退去）；
// - 新旧波形在环的正后方交接（最旧的已播让位给最新的未播），交接点固定不动；
// - 环本身不自转 —— 是波形内容随播放流过环面。
// 环是纯椭圆几何（无透视压缩），配上回环的低频呼吸半径、中心轴线与节拍配色。

/** 单帧最大步长，防止切页/掉帧时跳变。 */
const WAVEFORM_MAX_FRAME_SECONDS = 1 / 20;
/** canvas 背衬的 DPR 上限：波形是描线，2 倍足够锐。 */
const WAVEFORM_MAX_DPR = 2;
/** 回环的环长轴视口占比与上限。 */
const WAVEFORM_RING_WIDTH_RATIO = 0.44;
const WAVEFORM_MAX_RING_PX = 560;
/** 播放头（环正前方的「现在」节点）亮线的半长（相对环长轴）与基础宽度。 */
const PLAYHEAD_LENGTH_RATIO = 0.10;
const PLAYHEAD_WIDTH_PX = 2.6;

/**
 * 波形渐变的分段数（每半圈）。颜色、线宽、透明度都按段在 stroke() 时生效 ——
 * canvas 一笔只能有一个样式，整圈一笔会让每根条的设置被最后一根覆盖。段越细越顺滑。
 */
const WAVEFORM_GRADIENT_SEGMENTS = 48;

/** 把分析器能量统一到 0..1（部分来源给的是 0..255 的原始值）。 */
const normalizePower = (power: number, rawScaleRef: { current: boolean }): number => {
    if (!Number.isFinite(power)) return 0;
    if (power > 1.0) {
        rawScaleRef.current = true;
    }
    return Math.max(0, Math.min(1, rawScaleRef.current ? power / 255 : power));
};

const VisualizerWaveform: React.FC<VisualizerSharedProps> = (props) => {
    const {
        theme,
        showText = true,
        currentTime,
        audioPower,
        audioBands,
        waveformTuning = DEFAULT_WAVEFORM_TUNING,
        lyricsFontScale = 1.0,
        paused = false,
    } = props;

    const ellipseTiltDeg = waveformTuning.ellipseTiltDeg ?? DEFAULT_WAVEFORM_TUNING.ellipseTiltDeg;
    const focusScaleRatio = waveformTuning.focusScaleRatio ?? DEFAULT_WAVEFORM_TUNING.focusScaleRatio;
    const centerNormalTiltDeg = 90 - ellipseTiltDeg;
    const pointCount = resolveWaveformPointCount(waveformTuning.detail);
    const beatImpactGain = waveformTuning.beatImpact ?? DEFAULT_WAVEFORM_TUNING.beatImpact;
    const beatSensitivity = waveformTuning.beatSensitivity ?? DEFAULT_WAVEFORM_TUNING.beatSensitivity;
    const beatAttack = waveformTuning.beatAttack ?? DEFAULT_WAVEFORM_TUNING.beatAttack;
    const beatDecay = waveformTuning.beatDecay ?? DEFAULT_WAVEFORM_TUNING.beatDecay;
    const beatExpand = waveformTuning.beatExpand ?? DEFAULT_WAVEFORM_TUNING.beatExpand;
    const beatPerspective = waveformTuning.beatPerspective ?? DEFAULT_WAVEFORM_TUNING.beatPerspective;

    // 整曲静态波形的来源：当前显示的歌 + 它的音频地址。渲染层读播放 store 与
    // VideoLayer/useVisualizerRendererModel 的做法一致（props 里没有歌的标识）。
    const displaySong = usePlaybackStore(selectDisplaySong);
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const duration = usePlaybackStore(state => state.duration);

    const [peaks, setPeaks] = useState<Float32Array | null>(null);

    const smoothingRadius = resolveWaveformSmoothingRadiusBins(waveformTuning.smoothing, peaks?.length ?? 0);
    // 「提前平滑好」：整曲峰值只在 peaks 或平滑设置变化时卷积一次，帧循环直接取样。
    // 逐帧卷积（原来每帧 480~1920 × 155 次）会掉帧，掉帧时内容位置离散跳变 = 抽搐。
    const displayPeaks = useMemo(() => {
        if (!peaks || peaks.length === 0) return null;
        if (smoothingRadius <= 0) return peaks;
        const smoothed = new Float32Array(peaks.length);
        smoothPeakEnvelope(peaks, smoothingRadius, smoothed);
        return smoothed;
    }, [peaks, smoothingRadius]);

    useEffect(() => {
        // 切歌时 store 的更新分两拍：displaySong 先到、audioSrc（blob URL）后到。
        // 去抖半秒，等这一对稳定后再取字节分析 —— 不然会拿旧歌的 URL 解码出错的波形，
        // 或在 URL 还是 null 时白跑一趟（失败不缓存，会重试，但何必）。
        if (!displaySong) {
            setPeaks(null);
            return;
        }

        let cancelled = false;
        // 切歌就重来一次重拍检测：floor/peak 是自适应基线，跨歌沿用会让安静的歌开场误判。
        beatTrackerRef.current = createBandOnsetTracker();
        beatImpactRef.current = 0;
        tidePulseRef.current = 0;
        const timer = window.setTimeout(() => {
            // 分析是异步的：没出来之前先画兜底慢波，出来后一次性切换成静态整曲波形。
            void ensureSongWaveform(displaySong, audioSrc).then(result => {
                if (!cancelled) setPeaks(result);
            });
        }, 500);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [displaySong, audioSrc]);

    const rawScaleRef = useRef(false);
    const handleNormalize = useCallback((power: number) => normalizePower(power, rawScaleRef), []);

    // 与回环一致：半径由低频平滑值呼吸，旋转速度由整体音量决定。
    const smoothedBass = useSpring(audioBands.bass, { stiffness: 150, damping: 25 });
    const smoothedVocal = useSpring(audioBands.vocal, { stiffness: 120, damping: 24 });
    const smoothedPower = useSpring(audioPower, { stiffness: 140, damping: 26 });

    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const axisLineRef = useRef<HTMLDivElement>(null);
    const headMarkRef = useRef<HTMLDivElement>(null);
    const seepMarksRef = useRef<(HTMLDivElement | null)[]>([]);
    const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

    // 回环几何：长轴沿反斜对角倾斜（ellipseTiltDeg），短轴按固定比例压扁成扁环。
    const ringMajor = (dimensions.width > 0
        ? Math.min(dimensions.width * WAVEFORM_RING_WIDTH_RATIO, WAVEFORM_MAX_RING_PX)
        : 360) * waveformTuning.radiusScale * lyricsFontScale;

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const rect = container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            setDimensions({ width: rect.width, height: rect.height });
        }

        const observer = new ResizeObserver(entries => {
            const entry = entries[0];
            if (!entry) return;
            const { width, height } = entry.contentRect;
            if (width > 0 && height > 0) {
                setDimensions({ width, height });
            }
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    // canvas 背衬尺寸跟随容器（乘 DPR）；赋值 width/height 会重置上下文，随即补回变换。
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = Math.min(WAVEFORM_MAX_DPR, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
        canvas.width = Math.max(1, Math.round(dimensions.width * dpr));
        canvas.height = Math.max(1, Math.round(dimensions.height * dpr));
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }, [dimensions, showText]);

    // idle 时钟与上一帧时间放在 ref 里：依赖变化重启循环时波形不会跳。
    const idleTimeRef = useRef(0);
    // 「乐句级」的音量：窗口变焦和近端膨胀都靠它，避免逐帧抖动的瞬时音量把整条波形抽动起来。
    const flowVolumeRef = useRef(0);
    // 重拍：低频起音检测器的状态与那一记冲击的包络（0..1，逐帧衰减）。
    const beatTrackerRef = useRef<BandOnsetTracker>(createBandOnsetTracker());
    const beatImpactRef = useRef(0);
    // 交界向量的起音脉冲包络（0..1）：与平面的透视冲击共用同一次低频起音，但独立衰减。
    const tidePulseRef = useRef(0);
    const lastFrameRef = useRef(0);
    // 静态波形是 state（异步就位），RAF 闭包用 ref 跟住最新值，避免重挂循环。
    // displayPeaks 是「提前平滑好」的那份；帧循环只读它。
    const displayPeaksRef = useRef<Float32Array | null>(null);
    displayPeaksRef.current = displayPeaks;
    const durationRef = useRef(duration);
    durationRef.current = duration;

    useEffect(() => {
        if (!showText) return;

        const rot = -(ellipseTiltDeg * Math.PI) / 180;
        const cosRot = Math.cos(rot);
        const sinRot = Math.sin(rot);
        // 环上振幅缓冲：每帧只在里面重填取样值，不做任何卷积。
        const envelope = new Float32Array(pointCount);
        // 环上渐变色表：沿整圈从主色 → 强调色 → 次色 → 回到主色（闭合，无接缝）。
        // 主题不变时颜色也不变，所以一次性算好，帧循环里只查表（避免每帧 96 次颜色解析）。
        const ringPalette = [theme.primaryColor, theme.accentColor, theme.secondaryColor]
            .map(color => (typeof color === 'string' ? color.trim() : ''))
            .filter((color, index, all) => color !== '' && all.indexOf(color) === index);
        if (ringPalette.length === 0) {
            ringPalette.push('#ffffff');
        }
        const gradientColors: string[] = [];
        for (let step = 0; step < WAVEFORM_GRADIENT_SEGMENTS * 2; step += 1) {
            const stop = waveformRingGradientStop(ringPalette, (step + 0.5) / (WAVEFORM_GRADIENT_SEGMENTS * 2));
            gradientColors.push(mixColors(stop.from, stop.to, stop.amount, 1));
        }

        let frameId = 0;

        const frame = (now: number) => {
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext('2d');
            const last = lastFrameRef.current;
            const dt = last === 0 ? 0 : Math.min(WAVEFORM_MAX_FRAME_SECONDS, Math.max(0, (now - last) / 1000));
            lastFrameRef.current = now;

            const bassPower = paused ? 0 : handleNormalize(smoothedBass.get());
            const vocalPower = paused ? 0 : handleNormalize(smoothedVocal.get());
            const volume = paused ? 0 : handleNormalize(smoothedPower.get());
            // 把瞬时音量压成「乐句级」动态：几何量（窗口变焦、近端膨胀）只认它。
            // 直接用瞬时音量会让整条波形随分贝逐帧抽动 —— 那是「抽搐」的来源。
            flowVolumeRef.current = approachExponential(
                flowVolumeRef.current,
                volume,
                dt,
                WAVEFORM_FLOW_VOLUME_TAU,
            );
            const flowVolume = flowVolumeRef.current;

            // 中心轴线（环的短轴方向）：沿用回环的配色与低频呼吸。不依赖 canvas。
            const lineEl = axisLineRef.current;
            if (lineEl) {
                const fromColor = theme.primaryColor || '#ffffff';
                let toColor = theme.accentColor || '#ffffff';
                if (toColor === fromColor && theme.secondaryColor) {
                    toColor = theme.secondaryColor;
                }
                if (toColor === fromColor) {
                    toColor = '#ffffff';
                }

                const colorPower = Math.max(bassPower, vocalPower);
                const colorRatio = Math.min(1.0, Math.max(0, colorPower - 0.02) / 0.58);
                const mixed = mixColors(fromColor, toColor, colorRatio, 0.2 + 0.75 * colorRatio);
                const gradientString = `linear-gradient(90deg, transparent, ${mixed} 20%, ${mixed} 80%, transparent)`;
                lineEl.style.background = gradientString;
                lineEl.style.backgroundImage = gradientString;

                const bassSqr = bassPower * bassPower;
                const scaleX = 1.0 + bassSqr * 1.5;
                const scaleY = 1.0 + bassSqr * 0.5;
                lineEl.style.transform = `translate(-50%, -50%) rotate(${centerNormalTiltDeg}deg) scale(${scaleX}, ${scaleY})`;

                const glowSize = 4 + bassPower * 12;
                lineEl.style.filter = glowSize > 0.4 ? `drop-shadow(0 0 ${glowSize.toFixed(1)}px ${colorWithAlpha(mixed, 1)})` : 'none';
            }

            if (canvas && ctx) {
                // 半径随低频呼吸（回环的强度档位）。
                const intensity = theme.animationIntensity || 'normal';
                let intensityMultiplier = 0.25;
                let maxScale = 1.25;
                if (intensity === 'calm') {
                    intensityMultiplier = 0.08;
                    maxScale = 1.08;
                } else if (intensity === 'chaotic') {
                    intensityMultiplier = 0.95;
                    maxScale = 1.95;
                }
                // 喂 tide 的锚点用「纯几何」半径：不含低频呼吸，也不含重拍冲击。
                // 呼吸会让锚点以音频速率径向来回；下游滤波器把这段位移读成速度后，量级比那股向量
                // 本身还大一个数量级 —— 水面被呼吸泵着抽（既盖过向量、又抖）。呼吸只属于画面。
                const anchorMajor = ringMajor;
                const anchorMinor = ringMajor * WAVEFORM_RING_MINOR_RATIO;

                // 重拍透视冲击：低频起音检测器（与 diorama 共用 bandOnsetTracker）每打一下
                // 触发一次，包络先按「前摇」升到这一下的强度，再按「回落」衰减。
                // 用**原始**分贝而不是弹簧值 —— 弹簧会把瞬态抹平，起音检测要的正是那一下。
                const rawBass = paused ? 0 : handleNormalize(audioBands.bass.get());
                const rawMid = paused ? 0 : handleNormalize(audioBands.mid.get());
                const bassSignal = stepBandOnsetTracker(
                    beatTrackerRef.current,
                    rawBass * beatSensitivity,
                    dt,
                );
                // 这一下有多重：取检测器归一化后的瞬态强度（约 0.42 起步），而不是恒定的 1 ——
                // 轻敲轻动、重击重动，冲击幅度本身就是「频率分贝」的函数。
                const beatLevel = bassSignal.onset ? Math.max(0.35, bassSignal.transient) : 0;
                beatImpactRef.current = stepEnvelopeToward(
                    beatImpactRef.current,
                    beatLevel,
                    1 / Math.max(1e-3, beatAttack),
                    1 / Math.max(1e-3, beatDecay),
                    dt,
                );
                // 幅度由低频分贝驱动、角度由中频分贝驱动：两者各自成为「分贝的函数」。
                const punch = beatImpactRef.current * beatImpactGain;
                const expandPunch = punch * beatExpand * (0.45 + 0.55 * rawBass);
                const perspectivePunch = punch * beatPerspective * (0.45 + 0.55 * rawMid);

                // 画面用的半径（带冲击）：扩张幅度压在 0.22 以内，不再是「炸开」。
                const radiusFactor = Math.min(
                    (1 + bassPower * intensityMultiplier) * (1 + expandPunch * 0.22),
                    maxScale * 1.12,
                );
                const major = ringMajor * radiusFactor;
                // 透视：重拍把扁环「转正」一点（短轴朝长轴靠），像镜头怼近了一瞬。
                const minor = major * Math.min(
                    0.85,
                    WAVEFORM_RING_MINOR_RATIO + perspectivePunch * 0.20,
                );
                // 冲击：条长同时爆一下（幅度较小，靠前摇+回落做质感）。
                const maxAmplitude = major * WAVEFORM_AMPLITUDE_RATIO * (1 + expandPunch * 0.30);

                // idle 时钟只用于兜底波的相位；环不自转，内容随播放流动。
                idleTimeRef.current += dt;

                // 节拍配色（与轴线同一套口径）：随低频/人声从主色推向强调色。
                const fromColor = theme.primaryColor || '#ffffff';
                let toColor = theme.accentColor || '#ffffff';
                if (toColor === fromColor && theme.secondaryColor) {
                    toColor = theme.secondaryColor;
                }
                if (toColor === fromColor) {
                    toColor = '#ffffff';
                }
                const colorRatio = Math.min(1.0, Math.max(0, Math.max(bassPower, vocalPower) - 0.02) / 0.58);
                const coreColor = mixColors(fromColor, toColor, colorRatio, 1);
                const futureColor = mixColors(fromColor, toColor, Math.max(colorRatio, 0.5), 1);

                // 环形时间轴：现在 = 播放头，窗口前后各半圈；歌还没加载就用满额窗口画兜底波。
                // 窗口随「乐句级」音量收窄 —— 越响内容流过播放头越快，但绝不用瞬时音量，
                // 否则整条波形会随分贝逐帧来回抽动（窗口会重映射环上每一个点）。
                const totalSeconds = durationRef.current;
                const nowSeconds = currentTime.get();
                const windowSeconds = applyWaveformWindowVolume(
                    resolveWaveformWindowSeconds(totalSeconds),
                    flowVolume,
                );

                const staticPeaks = displayPeaksRef.current;
                const hasStatic = staticPeaks && staticPeaks.length > 0 && totalSeconds > 0;
                const centerX = dimensions.width / 2;
                const centerY = dimensions.height / 2;

                // 环上某归一化位置 t（0=正前方，0.5=正后方）的椭圆位置与外法线（纯椭圆几何）。
                // 半径是可变的：画面用带呼吸/冲击的 major/minor，喂 tide 的锚点用纯几何的
                // anchorMajor/anchorMinor —— 视觉与向量必须用两套半径，否则画面一动水面就被抽。
                const ellipsePoint = (t: number, useMajor: number, useMinor: number) => {
                    const angle = t * Math.PI * 2;
                    const sinAngle = Math.sin(angle);
                    const cosAngle = Math.cos(angle);
                    const baseX = sinAngle * useMajor;
                    const baseY = cosAngle * useMinor;
                    // 椭圆 (a·sinθ, b·cosθ) 的外法线 ∝ (b·sinθ, a·cosθ)。
                    const normalX = useMinor * sinAngle * cosRot - useMajor * cosAngle * sinRot;
                    const normalY = useMinor * sinAngle * sinRot + useMajor * cosAngle * cosRot;
                    const normalLength = Math.hypot(normalX, normalY) || 1;
                    return {
                        x: centerX + baseX * cosRot - baseY * sinRot,
                        y: centerY + baseX * sinRot + baseY * cosRot,
                        nx: normalX / normalLength,
                        ny: normalY / normalLength,
                    };
                };
                /** 画面用：含低频呼吸与重拍冲击。 */
                const ringPoint = (t: number) => ellipsePoint(t, major, minor);
                /** 喂 tide 的锚点用：纯几何，呼吸与冲击都不参与（否则被滤波器读成速度）。 */
                const anchorPoint = (t: number) => ellipsePoint(t, anchorMajor, anchorMinor);

                // 屏幕空间的前后深度：以播放头方向（环的近端）为「前」。近大远小跟着它走，
                // 而不是跟着时间半圈走 —— 否则近侧弧里属于过去的那一段会暗、远侧弧里属于
                // 未来的那一段会亮，看起来就是近暗远亮，前后反了。
                const headOffset = ringPoint(0);
                const headDirX = headOffset.x - centerX;
                const headDirY = headOffset.y - centerY;
                const headDirLength = Math.hypot(headDirX, headDirY) || 1;
                const nearDirX = headDirX / headDirLength;
                const nearDirY = headDirY / headDirLength;
                // 椭圆在 nearDir 上的支撑半径（采 16 点取最大投影），用它把深度归一化到 -1..1。
                let supportRadius = 1;
                for (let step = 0; step < 16; step += 1) {
                    const probe = ringPoint(step / 16);
                    const projection = (probe.x - centerX) * nearDirX + (probe.y - centerY) * nearDirY;
                    if (projection > supportRadius) supportRadius = projection;
                }
                const depthAt = (point: { x: number; y: number; }): number => {
                    const projection = (point.x - centerX) * nearDirX + (point.y - centerY) * nearDirY;
                    return Math.max(-1, Math.min(1, projection / supportRadius));
                };

                // 环上振幅：静态整曲波形按环形时间轴取样（歌曲范围之外是空白）。
                // 平滑早已在整曲峰值上「提前算好」（displayPeaks），这里只做取样 —— 帧内零卷积。
                for (let index = 0; index < pointCount; index += 1) {
                    const t = index / pointCount;
                    if (hasStatic) {
                        const songTime = songTimeAtRingT(t, nowSeconds, windowSeconds);
                        envelope[index] = songTime < 0 || songTime > totalSeconds
                            ? 0
                            : sampleStaticWaveformAt(staticPeaks, songTime / totalSeconds);
                    } else {
                        envelope[index] = Math.abs(synthIdleWaveformSample(t, idleTimeRef.current)) * 1.8;
                    }
                }
                // 插值取值：播放头/融环点的位置是连续的，用 round 取整会让它们的振幅逐格跳变。
                const amplitudeAt = (t: number): number => {
                    const wrapped = ((t % 1) + 1) % 1;
                    const scaled = wrapped * pointCount;
                    const i0 = Math.floor(scaled) % pointCount;
                    const i1 = (i0 + 1) % pointCount;
                    const fraction = scaled - Math.floor(scaled);
                    return envelope[i0] + (envelope[i1] - envelope[i0]) * fraction;
                };

                // 清屏（临时回到设备像素坐标，避免受 DPR 变换影响）。
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.restore();

                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';

                // 波形：静态峰值按环形时间轴贴满整环，径向双向镜像（FL clip 波形）。
                // 颜色沿整圈渐变（主色 → 强调色 → 次色 → 回到主色，闭合无缝）；未来半圈更亮、
                // 过去半圈更暗 —— 时间仍由透明度说话，近大远小由深度说话。
                //
                // 必须逐段描边：canvas 的 strokeStyle / lineWidth / globalAlpha 是在 stroke()
                // 时才生效的，整圈一笔的话每根条的设置都会被最后一根覆盖（渐变和近大远小都会失效）。
                const drawWaveformPass = (fromT: number, toT: number, stepBase: number, baseWidth: number, baseAlpha: number) => {
                    if (toT <= fromT) return;
                    for (let segment = 0; segment < WAVEFORM_GRADIENT_SEGMENTS; segment += 1) {
                        const segFrom = fromT + ((toT - fromT) * segment) / WAVEFORM_GRADIENT_SEGMENTS;
                        const segTo = fromT + ((toT - fromT) * (segment + 1)) / WAVEFORM_GRADIENT_SEGMENTS;
                        const startIdx = Math.floor(segFrom * pointCount);
                        const endIdx = Math.max(startIdx + 1, Math.ceil(segTo * pointCount));
                        const midNearness = (depthAt(ringPoint((segFrom + segTo) / 2)) + 1) / 2;

                        ctx.strokeStyle = gradientColors[stepBase + segment];
                        ctx.globalAlpha = baseAlpha * (0.45 + 0.55 * midNearness);
                        ctx.lineWidth = baseWidth * (0.6 + 0.55 * midNearness);
                        ctx.beginPath();
                        for (let index = startIdx; index < endIdx; index += 1) {
                            const t = index / pointCount;
                            const point = ringPoint(t);
                            const amplitude = envelope[index % pointCount];
                            const barNearness = (depthAt(point) + 1) / 2;
                            // 近端的条更长（近大远小），乐句级音量再往近端叠一点膨胀。
                            const sizeBoost = (0.55 + 0.45 * barNearness) * (1 + flowVolume * 0.9 * barNearness * barNearness);
                            const extent = amplitude * maxAmplitude * sizeBoost;
                            ctx.moveTo(point.x - point.nx * extent, point.y - point.ny * extent);
                            ctx.lineTo(point.x + point.nx * extent, point.y + point.ny * extent);
                        }
                        ctx.stroke();
                    }
                    ctx.globalAlpha = 1;
                    ctx.lineWidth = 1;
                };

                // 未来（新波形）：从播放头流向正后方交接点。
                drawWaveformPass(0, 0.5, 0, 1.6 + focusScaleRatio * 1.2, 0.95);
                // 过去（旧波形）：从正后方交接点流回播放头。
                drawWaveformPass(0.5, 1, WAVEFORM_GRADIENT_SEGMENTS, 1.2 + focusScaleRatio * 0.8, 0.42);

                // 播放头（「现在」）：钉死在环的正前方、中心轴线的近端上，永远正对视角。
                // 长度跟着此刻的真实振幅走，亮度跟着实时音量走。
                const head = ringPoint(0);
                const headAmplitude = hasStatic ? amplitudeAt(0) : 0.5;
                const headExtent = maxAmplitude * (0.45 + headAmplitude * 0.55) * (1 + flowVolume * 0.35);

                // 播放头拖影：在它身后（刚流过的那一小段）叠几条渐隐短线，越响拖得越长越亮。
                const trailReach = 0.55 + volume * 1.15;
                for (let echo = 1; echo <= 4; echo += 1) {
                    const echoT = WAVEFORM_JET_RING_T - echo * 0.012;
                    const echoPoint = ringPoint(echoT);
                    const echoAmplitude = hasStatic ? amplitudeAt(echoT) : 0.5;
                    const echoExtent = maxAmplitude * (0.42 + echoAmplitude * 0.5) * (1 - echo * 0.14);
                    ctx.globalAlpha = (0.04 + 0.14 * volume) * (1 - echo * 0.2) * trailReach;
                    ctx.strokeStyle = colorWithAlpha(futureColor, 0.45);
                    ctx.lineWidth = PLAYHEAD_WIDTH_PX * (1.5 - echo * 0.22);
                    ctx.beginPath();
                    ctx.moveTo(echoPoint.x - echoPoint.nx * echoExtent, echoPoint.y - echoPoint.ny * echoExtent);
                    ctx.lineTo(echoPoint.x + echoPoint.nx * echoExtent, echoPoint.y + echoPoint.ny * echoExtent);
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;

                ctx.globalAlpha = 0.95;
                ctx.strokeStyle = colorWithAlpha(futureColor, 0.35);
                ctx.lineWidth = PLAYHEAD_WIDTH_PX * 2.4;
                ctx.beginPath();
                ctx.moveTo(head.x - head.nx * headExtent, head.y - head.ny * headExtent);
                ctx.lineTo(head.x + head.nx * headExtent, head.y + head.ny * headExtent);
                ctx.stroke();
                ctx.strokeStyle = futureColor;
                ctx.lineWidth = PLAYHEAD_WIDTH_PX;
                ctx.beginPath();
                ctx.moveTo(head.x - head.nx * headExtent, head.y - head.ny * headExtent);
                ctx.lineTo(head.x + head.nx * headExtent, head.y + head.ny * headExtent);
                ctx.stroke();
                ctx.globalAlpha = 1;

                // 新旧交接点：环的正后方，最旧的已播波形在这里让位给最新的未播波形。
                // 一小截安静的暗线做标记，让「环形时间轴在这里折返」读得出来。
                const tail = ringPoint(0.5);
                const tailExtent = major * PLAYHEAD_LENGTH_RATIO * 0.55;
                ctx.globalAlpha = 0.3;
                ctx.strokeStyle = coreColor;
                ctx.lineWidth = 1.4;
                ctx.beginPath();
                ctx.moveTo(tail.x - tail.nx * tailExtent, tail.y - tail.ny * tailExtent);
                ctx.lineTo(tail.x + tail.nx * tailExtent, tail.y + tail.ny * tailExtent);
                ctx.stroke();
                ctx.globalAlpha = 1;

                // 有静态波形时才有的「环底光」：沿椭圆画一条极淡的轨道线，让环的轮廓
                // 在安静段也读得出来（参考那条发光的椭圆轨道）。
                if (hasStatic) {
                    ctx.globalAlpha = 0.18;
                    ctx.strokeStyle = coreColor;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.ellipse(centerX, centerY, major, minor, rot, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.globalAlpha = 1;
                }

                // 播放头 DOM 锚点：一个零尺寸的标记元素跟着 canvas 上的播放头走。
                // 波环没有文字 DOM，tide 潮汐背景的歌词采样拿不到任何锚点；它读的是这个
                // 标记的位置（见 tideGlyphDom 的 data-tide-playhead），让水面在「现在」
                // 被搅动 —— 强度随此刻的波形振幅（data-tide-strength）。这个标记同时承载
                // 那股「交界向量」：位置、方向、动量都在下面一起写。
                const headMark = headMarkRef.current;
                if (headMark) {
                    // 用纯几何：这个标记是喂 tide 的向量，画面上的呼吸与冲击都不能进来。
                    const headAnchor = anchorPoint(WAVEFORM_JET_RING_T);
                    headMark.style.transform = `translate(${headAnchor.x.toFixed(1)}px, ${headAnchor.y.toFixed(1)}px)`;
                    // 强度 = 此刻的波形振幅（「现在」的染料与抬升），也让 tide 的最强锚点恒在此处，
                    // 节拍波环于是固定从「现在」发出、不会在环上乱跳。
                    headMark.dataset.tideStrength = (0.6 + headAmplitude * 0.4).toFixed(3);

                    // 向量方向：中心轴线偏右下这一端（播放头 /「现在」）处环的切向，取 y 朝下
                    // （屏幕 y 正）的那一支 —— 默认 45° 倾角时正好指斜左下。
                    const jetProbe = anchorPoint(WAVEFORM_JET_RING_T - 0.01);
                    let dirX = headAnchor.x - jetProbe.x;
                    let dirY = headAnchor.y - jetProbe.y;
                    if (dirY < 0) {
                        dirX = -dirX;
                        dirY = -dirY;
                    }
                    // 慢摆：方向在 ±20° 内以约 10s 周期来回，水于是被「搅」而不是被「直推」。
                    const sway = waveformJetSway(idleTimeRef.current);
                    const swayCos = Math.cos(sway);
                    const swaySin = Math.sin(sway);
                    const swayedX = dirX * swayCos - dirY * swaySin;
                    const swayedY = dirX * swaySin + dirY * swayCos;
                    headMark.dataset.tideOut = `${swayedX.toFixed(4)},${swayedY.toFixed(4)}`;

                    // 推力只在低频起音那一下给（脉冲式）。连续恒定的推力会在一个固定点上驻成一个
                    // 漩涡（旁边卷出反向涡，再被涡量约束放大），而它逐帧变化的强度就是那股抽搐；
                    // 脉冲式则是一记一记地喷，吹出去就散；每一记的高度仍由分贝 × 频率决定。
                    tidePulseRef.current = stepEnvelopeToward(
                        tidePulseRef.current,
                        bassSignal.onset ? 1 : 0,
                        1 / WAVEFORM_JET_PULSE_ATTACK,
                        1 / WAVEFORM_JET_PULSE_DECAY,
                        dt,
                    );
                    const jetMomentum = resolveWaveformJetMomentum(volume, bassPower) * tidePulseRef.current;
                    headMark.dataset.tidePush = jetMomentum.toFixed(3);
                }

                // 下半弧渗染：环底部固定的一小段上一起渗染料（只出染料、不带方向推力），
                // 强度随该处波形振幅起伏 —— 读作「环在渗」，而不是一个点在推。
                for (let index = 0; index < WAVEFORM_SEEP_ARC_T.length; index += 1) {
                    const mark = seepMarksRef.current[index];
                    if (!mark) continue;

                    const seepT = WAVEFORM_SEEP_ARC_T[index];
                    const seepPoint = anchorPoint(seepT);
                    mark.style.transform = `translate(${seepPoint.x.toFixed(1)}px, ${seepPoint.y.toFixed(1)}px)`;
                    mark.dataset.tideStrength = resolveWaveformSeepStrength(amplitudeAt(seepT)).toFixed(3);
                }
            }

            frameId = requestAnimationFrame(frame);
        };

        frameId = requestAnimationFrame(frame);
        return () => {
            cancelAnimationFrame(frameId);
            lastFrameRef.current = 0;
        };
    }, [
        audioBands,
        beatAttack,
        beatDecay,
        beatExpand,
        beatImpactGain,
        beatPerspective,
        beatSensitivity,
        centerNormalTiltDeg,
        currentTime,
        dimensions,
        ellipseTiltDeg,
        focusScaleRatio,
        handleNormalize,
        pointCount,
        ringMajor,
        showText,
        smoothedBass,
        smoothedPower,
        smoothedVocal,
        theme.accentColor,
        theme.animationIntensity,
        theme.primaryColor,
        theme.secondaryColor,
        paused,
    ]);

    return (
        <VisualizerShell
            theme={theme}
            audioPower={audioPower}
            audioBands={audioBands}
            sharedProps={props}
        >
            <motion.div
                initial={{ opacity: 0, scale: 0.96, filter: 'blur(4px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 1.04, filter: 'blur(4px)' }}
                transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                ref={containerRef as any}
                className="relative flex flex-col items-center justify-center w-full h-full overflow-hidden select-none"
            >
                {/* 中心轴线（回环样式原样保留） */}
                <div className="absolute inset-0 overflow-hidden pointer-events-none z-[1]">
                    {waveformTuning.showAxisLine && (
                        <div
                            ref={axisLineRef}
                            style={{
                                position: 'absolute',
                                left: '50%',
                                top: '50%',
                                width: '300px',
                                height: '4px',
                                transform: `translate(-50%, -50%) rotate(${centerNormalTiltDeg}deg) scale(1, 1)`,
                                transformOrigin: 'center center',
                                willChange: 'background, transform, filter',
                            }}
                        />
                    )}
                </div>

                {/* 贴满整环的整曲静态波形 + 播放头 */}
                {showText && ringMajor > 0 && (
                    <>
                        <canvas
                            ref={canvasRef}
                            data-waveform-canvas="true"
                            className="pointer-events-none absolute inset-0 w-full h-full"
                            style={{ zIndex: 10, backgroundColor: 'transparent' }}
                        />
                        {/* 播放头 DOM 锚点：tide 潮汐背景从 stage 里找它来定位「现在」，
                            同时也读它上面的 data-tide-out / data-tide-push —— 那股朝斜左下的向量。 */}
                        <div
                            ref={headMarkRef}
                            data-tide-playhead="true"
                            data-tide-strength="0.5"
                            aria-hidden="true"
                            style={{
                                position: 'absolute',
                                left: 0,
                                top: 0,
                                width: 0,
                                height: 0,
                                pointerEvents: 'none',
                                zIndex: 1,
                            }}
                        />
                        {/* 下半弧渗染点：环底部一小段上的隐形标记，只出染料、不带方向推力。 */}
                        {Array.from({ length: WAVEFORM_SEEP_ARC_T.length }, (_, index) => (
                            <div
                                key={index}
                                ref={el => { seepMarksRef.current[index] = el; }}
                                data-tide-jet="true"
                                data-tide-out="0,0"
                                data-tide-strength="0"
                                aria-hidden="true"
                                style={{
                                    position: 'absolute',
                                    left: 0,
                                    top: 0,
                                    width: 0,
                                    height: 0,
                                    pointerEvents: 'none',
                                    zIndex: 1,
                                }}
                            />
                        ))}
                    </>
                )}
            </motion.div>
        </VisualizerShell>
    );
};

export default VisualizerWaveform;
