import { describe, expect, it } from 'vitest';
import { baseType, canRecordClip, clipExt, clipFile, pickClipType, planPostOnX, planSave, planShare, saveLabel, sheetPayload, X_HINT } from './clipFormat';

const file = new File(['x'], 'a.mp4', { type: 'video/mp4' });

describe('pickClipType', () => {
  it('prefers mp4 where it is supported (Safari)', () => {
    expect(pickClipType((t) => t.startsWith('video/mp4'))).toBe('video/mp4;codecs=avc1');
    expect(pickClipType((t) => t === 'video/mp4;codecs=avc1.42E01E,mp4a.40.2')).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
    expect(pickClipType((t) => t === 'video/mp4')).toBe('video/mp4');
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
    expect(planShare({ file: null })).toBe('text');
  });
  it('always shows the preview card first (never auto-opens the share sheet)', () => {
    expect(planShare({ file })).toBe('panel');
  });
});

describe('saving and posting the clip', () => {
  it('routes through the share sheet on touch devices that can share files, else a plain download', () => {
    expect(planSave({ canShareFile: true, touch: true })).toBe('sheet');
    expect(planSave({ canShareFile: true, touch: false })).toBe('download');
    expect(planSave({ canShareFile: false, touch: true })).toBe('download');
  });
  it('labels the sheet route "Save / Share Video" and the fallback "Download Video"', () => {
    expect(saveLabel('sheet')).toBe('Save / Share Video');
    expect(saveLabel('download')).toBe('Download Video');
  });
  it('the sheet gets the file only: no title, text or url (breaks iOS Safari)', () => {
    expect(Object.keys(sheetPayload(file))).toEqual(['files']);
  });
  it('Post on X is dropped on a phone with a file sheet, else opens the intent with a hint', () => {
    expect(planPostOnX({ canShareFile: true, touch: true })).toBe('hidden');
    expect(planPostOnX({ canShareFile: true, touch: false })).toBe('intent-hint');
    expect(planPostOnX({ canShareFile: false, touch: true })).toBe('intent-hint');
    expect(X_HINT).toBe('Save the video, then attach it in X');
  });
  it('builds an mp4-typed File from a blob, ignoring codec suffixes', () => {
    const f = clipFile(new Blob(['x']), 'video/mp4;codecs=avc1');
    expect(f.type).toBe('video/mp4');
    expect(f.name).toBe('pokejam-play-of-the-game.mp4');
    expect(clipFile(new Blob(['x']), 'video/webm;codecs=vp9').name).toMatch(/\.webm$/);
  });
});
