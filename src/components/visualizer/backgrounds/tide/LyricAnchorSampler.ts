import type { Line, Word } from '../../../../types';
import {
    collectTideGlyphs,
    findTideClusterIndex,
    measureTideGlyphRange,
    normalizeAnchorText,
} from './tideGlyphDom';

// src/components/visualizer/backgrounds/tide/LyricAnchorSampler.ts
// Answers "where are the lyrics right now" for the tide background: it measures the foreground
// visualizer's own lyric DOM, groups neighbours into a handful of clusters, and turns each cluster
// into an anchor (a position and a strength). It deliberately reports no velocity - a per-sample
// difference is far too noisy to push water with - so the motion is derived downstream from the
// smoothly filtered position (tideSplats.glideTideAnchors). Canvas-only visualizers expose no text
// nodes, so they degrade to a timing-driven synthetic anchor.

export interface TideAnchorSample {
    key: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    strength: number;
}

export interface TideAnchorInput {
    stage: HTMLElement | null;
    bounds: { left: number; top: number; width: number; height: number };
    lines: Line[];
    lineIndex: number;
    timeSec: number;
    /** 每次采样最多输出几组字形向量：设置页的"向量数量"上限，直接控制喂给流体的锚点个数。 */
    maxAnchors: number;
}

interface TideCluster {
    index: number;
    word: Word;
    envelope: number;
}

/** 前后各留一点时间，锚点在歌词唱到之前就已经开始推流体。 */
const ANCHOR_LEAD = 0.45;
const ANCHOR_TAIL = 0.5;
/** 几个字一组合成一个向量，避免逐字生成一堆细碎锚点。 */
const MAX_CLUSTERS = 6;
/** 画布类可视化的歌词没有 DOM，合成锚点沿舞台中下这条基线移动。 */
const FALLBACK_BASELINE = 0.47;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const envelopeOf = (word: Word, timeSec: number): number => {
    if (timeSec < word.startTime || timeSec > word.endTime) {
        const distance = timeSec < word.startTime
            ? word.startTime - timeSec
            : timeSec - word.endTime;
        const reach = timeSec < word.startTime ? ANCHOR_LEAD : ANCHOR_TAIL;
        return clamp(1 - distance / reach, 0, 1);
    }

    return 1;
};

/** 无状态：它只回答"字现在在哪"，运动交给下游滤波。 */
export class LyricAnchorSampler {
    sample(input: TideAnchorInput): TideAnchorSample[] {
        const line = input.lines[input.lineIndex];
        if (!line || !line.words || line.words.length === 0) {
            return [];
        }

        const clusters = this.pickClusters(line, input.timeSec, input.maxAnchors);
        if (clusters.length === 0) {
            return [];
        }

        const measured = this.measureClusters(input, clusters);
        return measured.length > 0
            ? measured
            : this.syntheticClusters(input, line, clusters);
    }

    /** 逐字：每个还在发声（含前后淡入淡出）的词都是一个锚点；超上限时优先保留唱得最重的那些。 */
    private pickClusters(line: Line, timeSec: number, maxAnchors: number): TideCluster[] {
        const limit = Math.round(clamp(Number.isFinite(maxAnchors) ? maxAnchors : MAX_CLUSTERS, 1, MAX_CLUSTERS));
        const alive: TideCluster[] = [];
        line.words.forEach((word, index) => {
            const envelope = envelopeOf(word, timeSec);
            if (envelope > 0.02) {
                alive.push({ index, word, envelope });
            }
        });

        if (alive.length <= limit) {
            return alive;
        }

        // 超上限时按权重取舍，再回到文档顺序：是逐字，不是按均匀步长跳字。
        const kept = [...alive]
            .sort((left, right) => right.envelope - left.envelope)
            .slice(0, limit);

        return kept.sort((left, right) => left.index - right.index);
    }

    private measureClusters(input: TideAnchorInput, clusters: TideCluster[]): TideAnchorSample[] {
        if (!input.stage || input.bounds.width <= 1 || input.bounds.height <= 1) {
            return [];
        }

        const { text, glyphs } = collectTideGlyphs(input.stage);
        if (glyphs.length === 0) {
            return [];
        }

        const samples: TideAnchorSample[] = [];
        let cursor = 0;

        for (const cluster of clusters) {
            const needle = normalizeAnchorText(cluster.word.text);
            if (!needle) {
                continue;
            }

            const start = findTideClusterIndex(text, needle, cursor);
            if (start < 0) {
                continue;
            }

            cursor = start + needle.length;
            const rect = measureTideGlyphRange(glyphs, start, needle.length);
            if (!rect) {
                continue;
            }

            const x = (rect.left + rect.width / 2 - input.bounds.left) / input.bounds.width;
            const y = 1 - (rect.top + rect.height / 2 - input.bounds.top) / input.bounds.height;
            if (x < -0.15 || x > 1.15 || y < -0.15 || y > 1.15) {
                continue;
            }

            samples.push({ key: `dom:${cluster.index}`, x, y, vx: 0, vy: 0, strength: cluster.envelope });
        }

        return samples;
    }

    /** 没有 DOM 歌词时的替身：沿一条基线随行唱进度摆动，强度减半。 */
    private syntheticClusters(
        input: TideAnchorInput,
        line: Line,
        clusters: TideCluster[],
    ): TideAnchorSample[] {
        const span = Math.max(0.4, line.endTime - line.startTime);
        const progress = clamp((input.timeSec - line.startTime) / span, 0, 1);
        const middle = (clusters.length - 1) / 2;

        return clusters.map((cluster, order) => ({
            key: `timing:${cluster.index}`,
            x: clamp(0.5 + (progress - 0.5) * 0.34 + (order - middle) * 0.17, 0.04, 0.96),
            y: clamp(FALLBACK_BASELINE + Math.sin((progress + order * 0.25) * Math.PI * 2) * 0.05, 0.08, 0.92),
            vx: 0,
            vy: 0,
            strength: cluster.envelope * 0.55,
        }));
    }
}
