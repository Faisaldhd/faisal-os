/** Written by build/ffmpeg-core.ts: where ffmpeg.wasm's core lives on our own origin. */
declare module 'virtual:ffmpeg-core' {
  const core: {
    /** Path of ffmpeg-core.js, relative to the page. */
    core: string;
    /** Paths of the wasm parts, in order, relative to the page. */
    parts: string[];
    /** Size of the joined wasm, in bytes. */
    size: number;
  };
  export default core;
}
