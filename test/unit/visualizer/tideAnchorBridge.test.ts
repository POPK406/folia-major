// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

// test/unit/visualizer/tideAnchorBridge.test.ts
// canvas 类可视化（商籁 / 绘光）把歌词画在 Pixi 画布内，DOM 里没有字形，tide 的字形采集
// 又明确跳过 canvas —— 它们只能靠这条桥把自己的逐字位置报出来。这里钉住两件事：
// 桥本身的发布/读取契约，以及取样侧把「画布逻辑像素」折算成舞台归一化坐标的算法。

import {
    beginTideAnchors,
    clearTideAnchors,
    publishTideAnchorFrom,
    pushTideAnchor,
    readTideAnchors,
    setTideAnchorCanvas,
} from '@/components/visualizer/backgrounds/tide/tideAnchorBridge';
import { LyricAnchorSampler } from '@/components/visualizer/backgrounds/tide/LyricAnchorSampler';
import type { Line } from '@/types';

const BOUNDS = { left: 0, top: 0, width: 1000, height: 1000 };

/** 画布在舞台里偏移 (100, 50)、尺寸 500×250：折算要看的是它自己的 rect，而不是舞台。 */
const CANVAS_RECT = { left: 100, top: 50, width: 500, height: 250 };

const buildCanvas = (overrides: Partial<{ connected: boolean; rect: typeof CANVAS_RECT }> = {}): HTMLCanvasElement => {
    const rect = overrides.rect ?? CANVAS_RECT;
    return {
        isConnected: overrides.connected ?? true,
        getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top }),
    } as unknown as HTMLCanvasElement;
};

const buildStage = (text: string): HTMLElement => {
    document.body.innerHTML = '';
    const stage = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = text;
    stage.appendChild(span);
    document.body.appendChild(stage);
    return stage;
};

const sample = (overrides: Partial<{ stage: HTMLElement | null; maxAnchors: number; lines: Line[]; lineIndex: number }> = {}) => (
    new LyricAnchorSampler().sample({
        stage: overrides.stage ?? null,
        maxAnchors: overrides.maxAnchors ?? 6,
        bounds: BOUNDS,
        lines: overrides.lines ?? [],
        lineIndex: overrides.lineIndex ?? 0,
        timeSec: 0,
    })
);

afterEach(() => {
    clearTideAnchors();
    document.body.innerHTML = '';
});

describe('tideAnchorBridge', () => {
    it('reads nothing until a canvas is registered and something is published', () => {
        beginTideAnchors();
        pushTideAnchor(10, 20, 1);
        expect(readTideAnchors()).toBeNull();

        setTideAnchorCanvas(buildCanvas());
        beginTideAnchors();
        expect(readTideAnchors()).toBeNull();

        pushTideAnchor(10, 20, 1);
        expect(readTideAnchors()?.count).toBe(1);
    });

    it('reports nothing once the canvas has left the document', () => {
        setTideAnchorCanvas(buildCanvas({ connected: false }));
        beginTideAnchors();
        pushTideAnchor(10, 20, 1);
        expect(readTideAnchors()).toBeNull();
    });

    it('drops the previous frame when a new one begins', () => {
        setTideAnchorCanvas(buildCanvas());
        beginTideAnchors();
        pushTideAnchor(1, 2, 0.5);
        pushTideAnchor(3, 4, 0.6);
        expect(readTideAnchors()?.count).toBe(2);

        beginTideAnchors();
        expect(readTideAnchors()).toBeNull();
    });

    it('caps how many anchors one frame may carry', () => {
        setTideAnchorCanvas(buildCanvas());
        beginTideAnchors();
        for (let index = 0; index < 600; index += 1) {
            pushTideAnchor(index, index, 1);
        }
        expect(readTideAnchors()?.count).toBeLessThanOrEqual(512);
    });

    it('publishes from a glyph container but never throws on a stub or a dark glyph', () => {
        setTideAnchorCanvas(buildCanvas());
        beginTideAnchors();

        // 桩对象 / 已销毁节点：没有 getGlobalPosition，直接跳过，不能把渲染层搞崩。
        publishTideAnchorFrom(null, 1);
        publishTideAnchorFrom({}, 1);
        // 未唱 / 未亮起：强度≈0，没有搅水的意义。
        publishTideAnchorFrom({ getGlobalPosition: () => ({ x: 30, y: 40 }) }, 0.01);
        expect(readTideAnchors()).toBeNull();

        publishTideAnchorFrom({ getGlobalPosition: () => ({ x: 30, y: 40 }) }, 0.5);
        expect(readTideAnchors()?.count).toBe(1);
        expect(readTideAnchors()?.anchors[0]).toEqual({ x: 30, y: 40, strength: 0.5 });
    });
});

describe('LyricAnchorSampler bridged anchors', () => {
    it('maps canvas pixels into stage coordinates through the canvas own rect', () => {
        setTideAnchorCanvas(buildCanvas());
        beginTideAnchors();
        // 画布左上 → 屏幕 (100, 50) → 舞台 x 0.1；y 要翻成「屏幕向上」→ 0.95
        pushTideAnchor(0, 0, 0.9);
        // 画布中心 → 屏幕 (350, 175) → 舞台 x 0.35；y → 1 - 0.175 = 0.825
        pushTideAnchor(250, 125, 0.8);

        const samples = sample();
        expect(samples).toHaveLength(2);
        expect(samples[0].x).toBeCloseTo(0.1, 6);
        expect(samples[0].y).toBeCloseTo(0.95, 6);
        expect(samples[1].x).toBeCloseTo(0.35, 6);
        expect(samples[1].y).toBeCloseTo(0.825, 6);
        // 位置照报，速度留给下游滤波。
        expect(samples[0].vx).toBe(0);
        expect(samples[0].vy).toBe(0);
        expect(samples[0].key).toBe('bridge:0');
    });

    it('lands on the exact same spot as the existing DOM mark path for the same screen point', () => {
        // 同一个屏幕点 (350, 175)：一边是画布像素 (250, 125)（画布 rect 在 100, 50），
        // 一边是视口坐标下零尺寸的标记。两条路径必须给出同一个归一化坐标 ——
        // 这条断言把 bridge 的 y 约定钉死在一个已经被视觉验证过的参照上，而不是钉在我的读码结论上。
        setTideAnchorCanvas(buildCanvas());
        beginTideAnchors();
        pushTideAnchor(250, 125, 1);
        const bridged = sample();

        clearTideAnchors();
        const stage = document.createElement('div');
        const mark = document.createElement('div');
        mark.dataset.tidePlayhead = 'true';
        mark.getBoundingClientRect = () => ({ left: 350, top: 175, right: 350, bottom: 175, width: 0, height: 0, x: 350, y: 175 }) as DOMRect;
        stage.appendChild(mark);
        document.body.appendChild(stage);
        const marks = sample({ stage });

        expect(bridged).toHaveLength(1);
        expect(marks).toHaveLength(1);
        expect(bridged[0].x).toBeCloseTo(marks[0].x, 9);
        expect(bridged[0].y).toBeCloseTo(marks[0].y, 9);
    });

    it('takes priority over DOM glyphs, which canvas modes do not have anyway', () => {
        const stage = buildStage('ABCD');
        setTideAnchorCanvas(buildCanvas());
        beginTideAnchors();
        pushTideAnchor(100, 50, 0.9);

        const samples = sample({ stage });
        expect(samples).toHaveLength(1);
        expect(samples[0].key).toBe('bridge:0');
    });

    it('keeps the strongest few, in a stable order, so keys do not churn every frame', () => {
        setTideAnchorCanvas(buildCanvas());
        beginTideAnchors();
        pushTideAnchor(0, 0, 0.4);
        pushTideAnchor(10, 0, 0.9);
        pushTideAnchor(20, 0, 0.7);
        pushTideAnchor(30, 0, 0.9);

        const samples = sample({ maxAnchors: 2 });
        expect(samples).toHaveLength(2);
        expect(samples.map(entry => entry.key)).toEqual(['bridge:1', 'bridge:3']);
    });

    it('falls back to the ordinary path when a canvas is registered but nothing is lit', () => {
        setTideAnchorCanvas(buildCanvas());
        beginTideAnchors();
        pushTideAnchor(100, 50, 0.01);

        // 没有可用锚点时必须原样走后面那条路（这里是无词、无标记 → 空）。
        expect(sample()).toEqual([]);
    });
});
