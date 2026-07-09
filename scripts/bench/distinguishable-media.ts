// I420 frame with a solid luma keyed to streamId + a 3-cell binary ID block top-left.
export function makeIdFrame(width: number, height: number, streamId: number): Uint8Array {
  const ySize = width * height;
  const frame = new Uint8Array(ySize + (ySize >> 1)); // I420
  frame.fill(16 + (streamId % 200), 0, ySize);        // distinct luma per stream
  frame.fill(128, ySize);                              // neutral chroma
  const cell = 16;
  for (let bit = 0; bit < 8; bit++) {                 // burn 8-bit id: bright cell = 1
    const on = (streamId >> bit) & 1;
    const x0 = bit * cell;
    for (let y = 0; y < cell; y++)
      for (let x = x0; x < x0 + cell; x++) frame[y * width + x] = on ? 235 : 16;
  }
  return frame;
}

export function readIdFrame(frame: Uint8Array, width: number, _height: number): number {
  const cell = 16;
  let id = 0;
  for (let bit = 0; bit < 8; bit++) {
    const cx = bit * cell + cell / 2, cy = cell / 2;
    if (frame[cy * width + cx] > 128) id |= 1 << bit;
  }
  return id;
}

export const toneHzFor = (streamId: number): number => 300 + streamId * 40;
