import type { SongResult } from '../types';
import { getPlaybackSourceRef } from '../utils/appPlaybackGuards';
import { saveAudioBlob } from './audioCache';
import { getFromCache, saveToCache } from './db';
import { getCachedSongAudioBlob } from './onlineMusic/resourceCache';
import { getSongResourceCacheKey } from './onlineMusic/resourceKeys';
import { getPlaybackAnalysisKey, getPlaybackRepresentation } from './playbackRecovery/representationRegistry';

// src/services/songWaveform.ts
//
// 整首歌的「预制」静态波形（FL 宿主时间轴那种 clip 波形）：取一次音频字节，解码，
// 压成固定数量的峰值 bin，之后永远从缓存读 —— 不播放也在，这是它和实时频谱的本质区别。
// 波环（waveform）模式的数据源；解码管线与 automix/profileService 同构，但输出的是
// 波形本体而不是过渡特征。

/** Bumped whenever the peak maths changes, so stored envelopes are re-measured. */
export const SONG_WAVEFORM_VERSION = 3;

/** Decode rate. 峰值只关心包络，22.05kHz 把四分钟压到 ~10MB。 */
export const SONG_WAVEFORM_SAMPLE_RATE = 22050;

/**
 * 每首歌存多少个峰值 bin（整曲时间轴的分辨率）。波环的环形时间轴只显示当前时刻
 * 前后一小段（默认 ±18s），bin 太稀的话那一小段里就只有几个点、看不出变化——
 * 16384 对四五分钟的歌约 60+ bin/秒，正对视角的那段波形有足够的逐拍细节。
 */
export const SONG_WAVEFORM_BINS = 16384;

interface StoredSongWaveform {
    version: number;
    bins: number;
    peaks: number[];
}

const memory = new Map<string, Float32Array>();
const inFlight = new Map<string, Promise<Float32Array | null>>();
const failedOnce = new Set<string>();
/** 同 profileService 的量级；每条 8192 个数，几百条也只是几 MB。 */
const MAX_MEMORY = 200;

const storageKey = (songKey: string) => `song_waveform_v${SONG_WAVEFORM_VERSION}_${songKey}`;

const remember = (songKey: string, peaks: Float32Array) => {
    memory.delete(songKey);
    memory.set(songKey, peaks);
    while (memory.size > MAX_MEMORY) {
        const oldest = memory.keys().next().value;
        if (oldest === undefined) break;
        memory.delete(oldest);
    }
};

/**
 * 把解码后的单声道采样压成 `bins` 个峰值（每 bin 内 max|sample|），再按全曲最大值归一化到 0..1。
 * 纯函数：service、单测和潜在的离线工具共用同一口径。
 */
export const buildWaveformPeaks = (samples: Float32Array, bins: number): Float32Array => {
    const peaks = new Float32Array(bins);
    if (samples.length === 0 || bins <= 0) return peaks;

    const perBin = samples.length / bins;
    let loudest = 0;
    for (let bin = 0; bin < bins; bin += 1) {
        const start = Math.floor(bin * perBin);
        const end = Math.max(start + 1, Math.min(samples.length, Math.floor((bin + 1) * perBin)));
        let peak = 0;
        for (let index = start; index < end; index += 1) {
            const magnitude = Math.abs(samples[index]);
            if (magnitude > peak) peak = magnitude;
        }
        peaks[bin] = peak;
        if (peak > loudest) loudest = peak;
    }
    if (loudest > 0) {
        for (let bin = 0; bin < bins; bin += 1) {
            peaks[bin] /= loudest;
        }
    }
    return peaks;
};

/** decodeAudioData 会重采样到 context 的采样率，所以 context 建在低采样率上就是免费的降采样。 */
const decodeMono = async (bytes: ArrayBuffer): Promise<Float32Array | null> => {
    const OfflineContext = window.OfflineAudioContext
        || (window as Window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!OfflineContext) return null;
    try {
        const buffer = await new OfflineContext(1, 1, SONG_WAVEFORM_SAMPLE_RATE).decodeAudioData(bytes);
        const left = buffer.getChannelData(0);
        if (buffer.numberOfChannels <= 1) return left;
        // 立体声取平均，包络不受某个声道偏置影响。
        const right = buffer.getChannelData(1);
        const mono = new Float32Array(left.length);
        for (let index = 0; index < left.length; index += 1) {
            mono[index] = (left[index] + right[index]) / 2;
        }
        return mono;
    } catch {
        return null;
    }
};

type BytesResult = { bytes: ArrayBuffer } | { skipped: string };

/**
 * 字节从哪来，与 automix/profileService 的顺序一致：播放表示 → 媒体缓存 → audioUrl。
 * 在线未缓存的曲目也允许这一次全量下载并落缓存 —— 用户切到波环模式就是冲着整曲波形来的，
 * 这不是后台悄悄预取，且下载写进的是同一个媒体缓存，之后播放不再花第二次流量。
 */
const readBytes = async (song: SongResult, audioUrl: string | null): Promise<BytesResult> => {
    const representation = getPlaybackRepresentation(song);
    if (representation) {
        try {
            const response = await fetch(representation.url);
            if (!response.ok) throw new Error(`representation responded ${response.status}`);
            return { bytes: await response.arrayBuffer() };
        } catch {
            return { skipped: 'the playback representation could not be read' };
        }
    }

    const cached = await getCachedSongAudioBlob(song);
    if (cached) return { bytes: await cached.arrayBuffer() };

    if (!audioUrl) return { skipped: 'not cached yet and no URL to read it from' };

    try {
        const blob = await (await fetch(audioUrl)).blob();
        const isLocal = audioUrl.startsWith('blob:') || audioUrl.startsWith('file:')
            || getPlaybackSourceRef(song).kind !== 'online';
        if (!isLocal) {
            await saveAudioBlob(getSongResourceCacheKey('audio', song), blob);
        }
        return { bytes: await blob.arrayBuffer() };
    } catch {
        return { skipped: 'the download failed' };
    }
};

/**
 * 返回整曲静态波形的峰值序列（0..1，长度 SONG_WAVEFORM_BINS），拿不到就 null。
 * 幂等：同一首歌并发调用共享同一次分析。
 *
 * 失败**不写缓存**（内存与持久化都只存成功）：切歌时 `displaySong` 先到、`audioSrc`
 * 的 blob URL 后到，第一次调用经常拿不到字节 —— 若把 null 记进内存，等 URL 到位后
 * 也永远读缓存、不再重试，每首歌都会停在渲染层的兜底波形上。失败只记日志（每首歌
 * 每种原因一次），下次调用（URL 就位后 effect 重跑）自然重试。
 */
export const ensureSongWaveform = async (
    song: SongResult | null | undefined,
    audioUrl: string | null,
): Promise<Float32Array | null> => {
    if (!song) return null;
    const songKey = getPlaybackAnalysisKey(song);

    const cachedPeaks = memory.get(songKey);
    if (cachedPeaks) return cachedPeaks;
    const pending = inFlight.get(songKey);
    if (pending) return pending;

    const task = (async () => {
        try {
            const stored = await getFromCache<StoredSongWaveform>(storageKey(songKey));
            if (stored && stored.version === SONG_WAVEFORM_VERSION && Array.isArray(stored.peaks) && stored.peaks.length > 0) {
                const peaks = Float32Array.from(stored.peaks);
                remember(songKey, peaks);
                return peaks;
            }

            const result = await readBytes(song, audioUrl);
            if ('skipped' in result) {
                if (!failedOnce.has(songKey)) {
                    failedOnce.add(songKey);
                    console.log(`[SongWaveform] not analysing "${song.name}" yet: ${result.skipped}`);
                }
                return null;
            }
            failedOnce.delete(songKey);

            const mono = await decodeMono(result.bytes);
            if (!mono) {
                if (!failedOnce.has(songKey)) {
                    failedOnce.add(songKey);
                    console.log(`[SongWaveform] could not decode "${song.name}"`);
                }
                return null;
            }

            const peaks = buildWaveformPeaks(mono, SONG_WAVEFORM_BINS);
            remember(songKey, peaks);
            await saveToCache(storageKey(songKey), {
                version: SONG_WAVEFORM_VERSION,
                bins: SONG_WAVEFORM_BINS,
                peaks: Array.from(peaks),
            } satisfies StoredSongWaveform);
            return peaks;
        } catch (error) {
            console.warn('[SongWaveform] analysis failed', error);
            return null;
        } finally {
            inFlight.delete(songKey);
        }
    })();

    inFlight.set(songKey, task);
    return task;
};

/** 测试与切库时清内存用。 */
export const clearSongWaveformRuntime = () => {
    memory.clear();
    inFlight.clear();
    failedOnce.clear();
};
