import { describe, expect, it } from 'vitest';
import { parse, wordToString, type Script } from '../shell/parser';

function ok(src: string): Script {
  const r = parse(src);
  if (!r.ok) throw new Error(`parse failed: ${r.message}`);
  return r.script;
}
const words = (src: string) => ok(src)[0].first.cmds[0].words.map(wordToString);

describe('parser', () => {
  it('splits words and handles quotes and escapes', () => {
    expect(words(`echo a  'b c' "d e" f\\ g`)).toEqual(['echo', 'a', 'b c', 'd e', 'f g']);
    expect(words(`echo "it's" 'say "hi"'`)).toEqual(['echo', "it's", 'say "hi"']);
    expect(words(`echo "a\\"b" 'x\\y'`)).toEqual(['echo', 'a"b', 'x\\y']);
    expect(words(`echo ""`)).toEqual(['echo', '']);
  });

  it('keeps variables as segments (single quotes stay literal)', () => {
    const w = ok(`echo $HOME "$USER-x" '$NOPE' \${A}b`)[0].first.cmds[0].words;
    expect(w[1]).toEqual([{ kind: 'var', name: 'HOME', quoted: false }]);
    expect(w[2][0]).toEqual({ kind: 'var', name: 'USER', quoted: true });
    expect(w[3]).toEqual([{ kind: 'lit', value: '$NOPE', quoted: true }]);
    expect(w[4]).toEqual([{ kind: 'var', name: 'A', quoted: false }, { kind: 'lit', value: 'b', quoted: false }]);
  });

  it('parses lists, and/or and pipelines', () => {
    const s = ok('a | b | c && d || e; f');
    expect(s).toHaveLength(2);
    expect(s[0].first.cmds).toHaveLength(3);
    expect(s[0].rest.map((r) => r.op)).toEqual(['&&', '||']);
    expect(wordToString(s[1].first.cmds[0].words[0])).toBe('f');
  });

  it('parses redirects and assignments', () => {
    const c = ok('FOO=1 BAR="x y" cmd < in > out 2>> err 2>&1')[0].first.cmds[0];
    expect(c.assigns.map((a) => [a.name, wordToString(a.value)])).toEqual([['FOO', '1'], ['BAR', 'x y']]);
    expect(c.redirs.map((r) => r.op)).toEqual(['<', '>', '2>>', '2>&1']);
    expect(c.redirs[1].target && wordToString(c.redirs[1].target)).toBe('out');
    expect(ok('echo hi >>log')[0].first.cmds[0].redirs[0].op).toBe('>>');
  });

  it('recognises ~ only at the start of a word', () => {
    expect(ok('cd ~/x')[0].first.cmds[0].words[1][0]).toEqual({ kind: 'tilde' });
    expect(ok('echo a~b')[0].first.cmds[0].words[1]).toEqual([{ kind: 'lit', value: 'a~b', quoted: false }]);
  });

  it('ignores comments', () => {
    expect(words('echo hi # not this')).toEqual(['echo', 'hi']);
  });

  it('reports incomplete input so the shell can ask for more', () => {
    for (const src of ['echo "abc', "echo 'x", 'ls |', 'true &&', 'echo \\']) {
      const r = parse(src);
      expect(r.ok, src).toBe(false);
      if (!r.ok) expect(r.incomplete, src).toBe(true);
    }
  });

  it('reports syntax errors bash-style', () => {
    const r = parse('| ls');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.incomplete).toBe(false);
      expect(r.message).toBe("syntax error near unexpected token `|'");
    }
    const r2 = parse('echo >');
    expect(r2.ok).toBe(false);
    const r3 = parse('sleep 1 &');
    expect(r3.ok).toBe(false);
  });
});
