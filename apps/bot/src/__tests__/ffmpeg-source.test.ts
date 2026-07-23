import { describe, it, expect, vi } from 'vitest';
import { FrameBuffer } from '../media/ffmpeg-source.js';

describe('FrameBuffer', () => {
  it('emits nothing until a full frame worth of bytes has arrived', () => {
    const onFrame = vi.fn();
    const fb = new FrameBuffer(10, onFrame);
    fb.push(Buffer.alloc(4));
    fb.push(Buffer.alloc(5));
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('emits exactly one frame once the frame size is reached, keeping the remainder buffered', () => {
    const onFrame = vi.fn();
    const fb = new FrameBuffer(10, onFrame);
    fb.push(Buffer.alloc(12, 1));
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]?.[0]).toHaveLength(10);
  });

  it('emits multiple frames when several frames worth of bytes arrive at once', () => {
    const onFrame = vi.fn();
    const fb = new FrameBuffer(4, onFrame);
    fb.push(Buffer.alloc(17)); // 4 full frames + 1 leftover byte
    expect(onFrame).toHaveBeenCalledTimes(4);
  });

  it('accumulates across pushes that individually are smaller than one frame', () => {
    const onFrame = vi.fn();
    const fb = new FrameBuffer(6, onFrame);
    fb.push(Buffer.alloc(2));
    fb.push(Buffer.alloc(2));
    expect(onFrame).not.toHaveBeenCalled();
    fb.push(Buffer.alloc(2));
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('I420 frame size math: width*height*1.5 for a 640x480 frame', () => {
    const width = 640;
    const height = 480;
    const frameSize = Math.floor(width * height * 1.5);
    const onFrame = vi.fn();
    const fb = new FrameBuffer(frameSize, onFrame);
    fb.push(Buffer.alloc(frameSize));
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(frameSize).toBe(460800);
  });

  it('48kHz mono s16le 10ms PCM chunk size is 960 bytes (480 samples * 2 bytes)', () => {
    const sampleRate = 48000;
    const channels = 1;
    const chunkMs = 10;
    const samplesPerChunk = (sampleRate / 1000) * chunkMs;
    const bytesPerChunk = samplesPerChunk * 2 * channels;
    expect(samplesPerChunk).toBe(480);
    expect(bytesPerChunk).toBe(960);
  });
});
