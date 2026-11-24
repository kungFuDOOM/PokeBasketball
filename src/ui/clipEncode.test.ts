import { describe, expect, it } from 'vitest';
import { chunkDurationUs, ENC_BPS, frameDurationUs, frameTimestampUs, hasWebCodecs, H264_CODECS, isEven, pickEncoderConfig, planEncoder, assertEvenSize } from './clipEncode';
import { VH, VW } from '../game/render';

describe('frame timing', () => {
  it('stamps frames exactly from the index, 30fps in microseconds', () => {
    expect(frameTimestampUs(0)).toBe(0);
    expect(frameTimestampUs(1)).toBe(33333);
    expect(frameTimestampUs(3)).toBe(100000);
    expect(frameTimestampUs(30)).toBe(1_000_000);
    expect(frameDurationUs()).toBe(33333);
  });
  it('gaps never drift more than 1us from 33.33ms over a 15s clip', () => {
    for (let i = 1; i <= 450; i++) expect(Math.abs(frameTimestampUs(i) - frameTimestampUs(i - 1) - 33333.33)).toBeLessThan(1);
  });
  it("uses our duration when Safari reports null/0/NaN", () => {
    expect(chunkDurationUs(null)).toBe(33333);
    expect(chunkDurationUs(undefined)).toBe(33333);
    expect(chunkDurationUs(0)).toBe(33333);
    expect(chunkDurationUs(NaN)).toBe(33333);
    expect(chunkDurationUs(33000)).toBe(33000);
  });
});

describe('size and bitrate', () => {
  it('the clip size is even (H.264 requirement)', () => {
    expect(isEven(VW * 2) && isEven(VH * 2)).toBe(true);
    expect(() => assertEvenSize(VW * 2, VH * 2)).not.toThrow();
    expect(() => assertEvenSize(961, 540)).toThrow();
  });
  it('bitrate stays modest', () => { expect(ENC_BPS).toBeGreaterThanOrEqual(6e6); expect(ENC_BPS).toBeLessThanOrEqual(8e6); });
});

describe('pickEncoderConfig', () => {
  const size = { width: 960, height: 540 };
  it('prefers Baseline with hardware, avc (not annexb), and checks the real size/bitrate/fps', async () => {
    const seen: unknown[] = [];
    const c = await pickEncoderConfig(async (x) => { seen.push(x); return { supported: true }; }, size);
    expect(c).toMatchObject({ codec: 'avc1.42001f', width: 960, height: 540, bitrate: ENC_BPS, framerate: 30, hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' } });
    expect(seen).toHaveLength(1);
  });
  it('drops hardware preference, then walks Baseline -> Main -> High', async () => {
    expect((await pickEncoderConfig(async (x) => ({ supported: !x.hardwareAcceleration }), size))?.hardwareAcceleration).toBeUndefined();
    expect((await pickEncoderConfig(async (x) => ({ supported: x.codec === 'avc1.4d001f' }), size))?.codec).toBe('avc1.4d001f');
    expect((await pickEncoderConfig(async (x) => ({ supported: x.codec === 'avc1.64001f' }), size))?.codec).toBe('avc1.64001f');
    expect(H264_CODECS).toEqual(['avc1.42001f', 'avc1.4d001f', 'avc1.64001f']);
  });
  it('is null when nothing is supported or the check throws; odd sizes are refused', async () => {
    expect(await pickEncoderConfig(async () => ({ supported: false }), size)).toBeNull();
    expect(await pickEncoderConfig(async () => { throw new Error('x'); }, size)).toBeNull();
    await expect(pickEncoderConfig(async () => ({ supported: true }), { width: 959, height: 540 })).rejects.toThrow();
  });
});

describe('capability and fallback', () => {
  it('detects VideoEncoder + VideoFrame', () => {
    expect(hasWebCodecs({ VideoEncoder: function () {}, VideoFrame: function () {} })).toBe(true);
    expect(hasWebCodecs({ VideoEncoder: function () {} })).toBe(false);
    expect(hasWebCodecs({})).toBe(false);
  });
  it('WebCodecs first, the MediaRecorder only as a fallback, else none', () => {
    expect(planEncoder({ webcodecs: true, recorder: true })).toBe('webcodecs');
    expect(planEncoder({ webcodecs: true, recorder: false })).toBe('webcodecs');
    expect(planEncoder({ webcodecs: false, recorder: true })).toBe('recorder');
    expect(planEncoder({ webcodecs: false, recorder: false })).toBe('none');
  });
});
