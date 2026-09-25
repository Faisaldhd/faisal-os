import { describe, expect, it } from 'vitest';
import { FILTER_IDS, applyFilter } from './ops';
import { downscale, presetThumbnails } from './engine';

/**
 * The filter strip must let a phone user tell the looks apart: every thumbnail is rendered
 * from the real image at 192 px, and no two filters may produce the same picture.
 */
describe('filter thumbnails', () => {
  it('are rendered at an adequate size and every look differs from every other', () => {
    const w = 400;
    const h = 300;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data[i] = (x * 200) / w + (((x >> 3) ^ (y >> 3)) & 1 ? 50 : 0); // gradient + texture
        data[i + 1] = (y * 255) / h;
        data[i + 2] = ((x + y) * 128) / (w + h) + 60;
        data[i + 3] = 255;
      }
    }
    const small = downscale({ width: w, height: h, data }, 192);
    expect(Math.max(small.width, small.height)).toBe(192);
    const looks = presetThumbnails(small, 192);
    const outs = FILTER_IDS.map((id) => looks.get(id) ?? applyFilter(small, id, 100, small.width / w));
    const mean = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let d = 0;
      for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) d += Math.abs(a[i] - b[i]);
      return d / ((a.length / 4) * 3);
    };
    for (let i = 0; i < outs.length; i++) {
      // (Blur barely changes a smooth gradient, so the bar against the original is low.)
      expect(mean(outs[i].data, small.data), FILTER_IDS[i]).toBeGreaterThan(0.3);
      for (let j = i + 1; j < outs.length; j++) {
        expect(mean(outs[i].data, outs[j].data), `${FILTER_IDS[i]} vs ${FILTER_IDS[j]}`).toBeGreaterThan(0.5);
      }
    }
  });
});
