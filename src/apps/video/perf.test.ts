import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installPerfHandle, perfBegin, perfMark, perfReport, perfReset, perfSpan, setPerfClock, type PerfHandle } from './perf';

/**
 * The readiness marks are the measuring instrument for "how long does a video take to open", so
 * the instrument itself is tested with a clock the test drives: a mark that lands in the wrong
 * session, or a span that records twice, would quietly bend every number in the report.
 */
describe('video perf marks', () => {
  let now = 0;
  let restore: () => number;

  beforeEach(() => {
    now = 0;
    restore = setPerfClock(() => now);
    perfReset();
  });

  afterEach(() => {
    restore();
    perfReset();
  });

  it('records a mark at its offset from the start of the session', () => {
    perfBegin('open:a.mp4');
    now = 12.5;
    perfMark('av:element');
    now = 40;
    perfMark('av:canplay', 'rs=4');

    const report = perfReport();
    expect(report.label).toBe('open:a.mp4');
    expect(report.entries.map((e) => [e.phase, e.at])).toEqual([['av:element', 12.5], ['av:canplay', 40]]);
    expect(report.entries[1].note).toBe('rs=4');
    expect(report.entries[0].ms).toBe(0);
  });

  it('measures a span from where it was opened to where it was closed', () => {
    perfBegin();
    now = 5;
    const done = perfSpan('thumbs', '12');
    now = 130;
    expect(done()).toBe(125);
    now = 900;
    // Closing twice must not record a second entry: `finally` blocks run once, but a caller that
    // also closes on the happy path would otherwise double the phase's cost.
    expect(done()).toBe(125);

    const report = perfReport();
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ phase: 'thumbs', kind: 'span', at: 5, ms: 125, note: '12' });
  });

  it('lets a closing note replace the opening one', () => {
    perfBegin();
    const done = perfSpan('metadata', 'opening');
    now = 3;
    done('rs=1');
    expect(perfReport().entries[0].note).toBe('rs=1');
  });

  it('summarises repeated spans instead of listing them one by one', () => {
    perfBegin();
    for (const cost of [10, 30, 20]) {
      const done = perfSpan('thumb');
      now += cost;
      done();
    }
    const report = perfReport();
    expect(report.spans.thumb).toEqual({ count: 3, totalMs: 60, maxMs: 30 });
    expect(report.entries).toHaveLength(3);
  });

  it('reports the whole session length, not just the last entry', () => {
    perfBegin();
    now = 25;
    perfMark('ready');
    now = 400;
    expect(perfReport().totalMs).toBe(400);
  });

  it('starts a clean session on begin() and forgets everything on reset()', () => {
    perfBegin('first');
    now = 10;
    perfMark('a');
    perfBegin('second');
    now = 17;
    perfMark('b');
    expect(perfReport().entries.map((e) => [e.phase, e.at])).toEqual([['b', 7]]);
    expect(perfReport().label).toBe('second');

    perfReset();
    const empty = perfReport();
    expect(empty.entries).toEqual([]);
    expect(empty.totalMs).toBe(0);
    expect(empty.label).toBe('');
  });

  it('rounds to microseconds so float noise never reaches a report', () => {
    perfBegin();
    now = 0.0001234;
    perfMark('m');
    expect(perfReport().entries[0].at).toBe(0);
    now = 1.9999999;
    const done = perfSpan('s');
    now = 3.0001;
    done();
    expect(perfReport().spans.s.totalMs).toBe(1);
  });

  it('exposes the same marks through the handle the browser harness reads', () => {
    const target: Record<string, unknown> = {};
    const handle = installPerfHandle(target) as PerfHandle;
    expect(target.__faisalVideoPerf).toBe(handle);

    handle.begin('open:b.mp4');
    now = 8;
    handle.mark('ready');
    const done = handle.span('thumbs');
    now = 20;
    done();

    const report = handle.report();
    expect(report.label).toBe('open:b.mp4');
    expect(report.spans.thumbs).toEqual({ count: 1, totalMs: 12, maxMs: 12 });
    handle.reset();
    expect(handle.report().entries).toEqual([]);
  });

  it('installs the handle on the global object when imported', () => {
    const installed = (globalThis as { __faisalVideoPerf?: PerfHandle }).__faisalVideoPerf;
    expect(installed).toBeTruthy();
    expect(typeof installed?.report).toBe('function');
  });
});
