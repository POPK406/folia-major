// src/components/visualizer/backgrounds/tide/tideAudio.ts
// The sound half of the tide: smoothed band energies, a bass onset detector, and the ring/focus
// payload the surface pass consumes. Kept apart from the runtime so the maths stays testable — and
// so it is obvious that nothing here ever pushes the fluid solver around (that is what turned the
// old audio-reactive mode into a jittering mess). Everything below only shapes the water surface.

/** How many beat rings can be alive at once. */
export const TIDE_PULSE_COUNT = 3;
/** How many lyric clusters the surface can lift at once (matches the anchor cap). */
export const TIDE_FOCUS_COUNT = 6;

export interface TideAudioBands {
    bass: number;
    lowMid: number;
    mid: number;
    vocal: number;
    treble: number;
}

export interface TideAudioInput {
    power: number;
    bands: TideAudioBands | null;
    dt: number;
    /** Seconds; used to age the rings. */
    time: number;
    /** Where a new ring is born (uv). */
    originX: number;
    originY: number;
    /** Smoothed lyric clusters, strongest first. */
    focus: Array<{ x: number; y: number; strength: number }>;
    /** 0 disables the whole sound layer (and scales the voicing and the rings up to 2). */
    amount: number;
    /** 0 disables the lyric pool (and scales the focus lift up to 2). */
    focusAmount: number;
}

export interface TideAudioFrame {
    /** 平滑后的整体响度（0..1）：歌词推水的动量按它放大，见 tideMomentumGain。 */
    level: number;
    /** 鼓点呼吸包络（0..1）：命中鼓点吸满，然后慢慢呼出。 */
    breath: number;
    bass: number;
    mid: number;
    treble: number;
    /** TIDE_PULSE_COUNT slots of (x, y, ageSeconds, strength); strength 0 marks a free slot. */
    pulses: number[][];
    /** TIDE_FOCUS_COUNT slots of (x, y, strength, 0); strength 0 marks a free slot. */
    focus: number[][];
}

/** The surface follows these, so they have to be smooth: a band that snaps every frame reads as a flicker. */
const BAND_TAU = 0.09;
/** The onset detector compares a fast follower against a slow one. */
const BASS_FAST_TAU = 0.03;
const BASS_SLOW_TAU = 1.1;
/**
 * 鼓点 = 快跟随者抬离慢基线。两点都是被踩过的坑：
 * 1) 用「加性余量」而不是比值 —— 慢基线升到 0.8 时「快 > 慢 × 1.22」需要 0.976，而快的上限也
 *    就 ~1.0，于是歌曲播几秒、基线收敛后就再也触发不了（波环/呼吸"只有开头几秒有效果"）；
 * 2) 快档要够快（~2 帧）—— 慢一点 EMA 就把鼓点的瞬态磨平，抬升量还是不够阈值。
 */
const ONSET_MARGIN = 0.07;
const ONSET_FLOOR = 0.05;
/** Two kicks closer than this are the same beat. */
const ONSET_MIN_GAP = 0.16;
/** A ring expands for this long before it is recycled. */
const RING_LIFE = 2.4;
/** 鼓点呼吸：命中时吸满，之后按这个时间常数呼出去（比鼓点间隔长，所以是"呼吸"不是"打点"）。 */
const BREATH_TAU = 0.55;
/** 持续低频也托一点呼吸：鼓点不密时水面不会完全停住。 */
const BREATH_BASS_FLOOR = 0.35;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const approach = (current: number, target: number, dt: number, tau: number): number =>
    current + (target - current) * (1 - Math.exp(-dt / Math.max(tau, 0.01)));

interface TideRing {
    x: number;
    y: number;
    age: number;
    strength: number;
}

export class TideAudio {
    private level = 0;
    private breath = 0;
    private bass = 0;
    private mid = 0;
    private treble = 0;
    private bassFast = 0;
    private bassSlow = 0;
    private lastOnset = Number.NEGATIVE_INFINITY;
    private rings: TideRing[] = [];

    reset(): void {
        this.rings = [];
        this.lastOnset = Number.NEGATIVE_INFINITY;
    }

    update(input: TideAudioInput): TideAudioFrame {
        const dt = clamp(input.dt, 1 / 240, 1 / 12);
        const source = input.bands;
        const power = clamp(input.power || 0, 0, 1);
        const bass = clamp(source ? source.bass : power, 0, 1);
        const mid = clamp(source ? (source.mid + source.vocal) / 2 : power * 0.6, 0, 1);
        const treble = clamp(source ? source.treble : power * 0.5, 0, 1);

        const amount = clamp(input.amount, 0, 2);
        const focusAmount = clamp(input.focusAmount, 0, 2);

        this.level = approach(this.level, power, dt, BAND_TAU);
        this.bass = approach(this.bass, bass, dt, BAND_TAU);
        this.mid = approach(this.mid, mid, dt, BAND_TAU);
        this.treble = approach(this.treble, treble, dt, BAND_TAU);
        this.bassFast = approach(this.bassFast, bass, dt, BASS_FAST_TAU);
        this.bassSlow = approach(this.bassSlow, bass, dt, BASS_SLOW_TAU);

        // A kick: the fast follower lifts clear of the slow baseline. One ring per beat, capped so a
        // busy low end cannot flood the surface.
        const onsetLift = this.bassFast - this.bassSlow;
        const kick = amount > 0
            && input.time - this.lastOnset >= ONSET_MIN_GAP
            && this.bassFast > ONSET_FLOOR
            && onsetLift > Math.max(ONSET_FLOOR, this.bassSlow * ONSET_MARGIN);

        if (kick) {
            this.lastOnset = input.time;
            this.rings.push({
                x: clamp(input.originX, 0.04, 0.96),
                y: clamp(input.originY, 0.12, 0.94),
                age: 0,
                // 环的强度就是这一击抬高了多少：轻鼓也看得见，重鼓到顶。
                strength: clamp(0.35 + onsetLift * 2, 0, 1),
            });
            if (this.rings.length > TIDE_PULSE_COUNT) {
                this.rings.shift();
            }
        }

        // 鼓点呼吸：命中时吸满，之后一直呼出（时间常数比鼓点间隔长），持续低频再托一个底。
        if (kick) {
            this.breath = 1;
        }
        this.breath *= Math.exp(-dt / BREATH_TAU);

        for (const ring of this.rings) {
            ring.age += dt;
        }
        while (this.rings.length > 0 && this.rings[0].age > RING_LIFE) {
            this.rings.shift();
        }

        const pulses: number[][] = [];
        for (let index = 0; index < TIDE_PULSE_COUNT; index += 1) {
            const ring = this.rings[index];
            if (ring) {
                const life = clamp(1 - ring.age / RING_LIFE, 0, 1);
                pulses.push([ring.x, ring.y, ring.age, ring.strength * life * amount]);
            } else {
                pulses.push([0, 0, 0, 0]);
            }
        }

        // The focus slots are filled left to right so a re-ordered anchor list cannot make the pool jump.
        const focus: number[][] = [];
        const ordered = [...input.focus].sort((left, right) => left.x - right.x);
        for (let index = 0; index < TIDE_FOCUS_COUNT; index += 1) {
            const entry = ordered[index];
            focus.push(entry
                ? [clamp(entry.x, 0, 1), clamp(entry.y, 0, 1), clamp(entry.strength, 0, 1) * focusAmount, 0]
                : [0, 0, 0, 0]);
        }

        return {
            level: this.level,
            breath: clamp(Math.max(this.breath, this.bass * BREATH_BASS_FLOOR), 0, 1) * amount,
            bass: this.bass * amount,
            mid: this.mid * amount,
            treble: this.treble * amount,
            pulses,
            focus,
        };
    }
}
