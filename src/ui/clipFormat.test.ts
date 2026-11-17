import { describe, expect, it } from 'vitest';
import { baseType, canRecordClip, clipExt, pickClipType, planShare } from './clipFormat';

const file = new File(['x'], 'a.mp4', { type: 'video/mp4' });

describe('pickClipType', () => {
  it('prefers mp4 where it is supported (Safari)', () => {
    expect(pickClipType((t) => t.startsWith('video/mp4'))).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
  });
  it('falls back to webm vp9, then vp8', () => {
    expect(pickClipType((t) => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9,opus');
    expect(pickClipType((t) => t === 'video/webm;codecs=vp8')).toBe('video/webm;codecs=vp8');
  });
  it('is null when nothing is supported or the check throws', () => {
    expect(pickClipType(() => false)).toBeNull();
    expect(pickClipType(() => { throw new Error('no'); })).toBeNull();
  });
  it('names the file and type', () => {
    expect(clipExt('video/mp4;codecs=avc1')).toBe('mp4');
    expect(clipExt('video/webm;codecs=vp9')).toBe('webm');
    expect(baseType('video/webm;codecs=vp9,opus')).toBe('video/webm');
  });
});

describe('canRecordClip', () => {
  it('needs both MediaRecorder and captureStream', () => {
    expect(canRecordClip({ MediaRecorder: {}, captureStream: () => {} })).toBe(true);
    expect(canRecordClip({ captureStream: () => {} })).toBe(false);
    expect(canRecordClip({ MediaRecorder: {} })).toBe(false);
  });
});

describe('planShare', () => {
  it('falls back to text/link without a clip', () => {
    expect(planShare({ file: null, canShareFile: true })).toBe('text');
  });
  it('shares natively when files can be shared, else shows the video', () => {
    expect(planShare({ file, canShareFile: true })).toBe('native');
    expect(planShare({ file, canShareFile: false })).toBe('panel');
  });
});
