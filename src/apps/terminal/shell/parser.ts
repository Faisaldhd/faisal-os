/**
 * Bash-like parser for the Faisal shell (pure, no DOM).
 *
 * Grammar (subset of POSIX sh):
 *   script   := andor ((';' | '\n') andor)*
 *   andor    := pipeline (('&&' | '||') pipeline)*
 *   pipeline := ['!'] command ('|' command)*
 *   command  := (assignment)* (word | redirect)+
 *
 * Words are kept as segments so that expansion ($VAR, ~, globs) can happen
 * at execution time with the right environment.
 */

export type Segment =
  | { kind: 'lit'; value: string; quoted: boolean }
  | { kind: 'var'; name: string; quoted: boolean }
  | { kind: 'tilde' };

export type Word = Segment[];

export type RedirOp = '>' | '>>' | '<' | '2>' | '2>>' | '2>&1' | '&>';

export interface Redirect { op: RedirOp; target: Word | null }

export interface SimpleCommand {
  assigns: { name: string; value: Word }[];
  words: Word[];
  redirs: Redirect[];
}

export interface Pipeline { negate: boolean; cmds: SimpleCommand[] }
export interface AndOr { first: Pipeline; rest: { op: '&&' | '||'; pipeline: Pipeline }[] }
export type Script = AndOr[];

export type ParseResult =
  | { ok: true; script: Script }
  | { ok: false; incomplete: true; message: string }
  | { ok: false; incomplete: false; message: string };

/* ─────────────────────────── Tokenizer ─────────────────────────── */

type Token =
  | { t: 'word'; word: Word; raw: string }
  | { t: 'op'; op: string };

class Incomplete extends Error {}
class SyntaxErr extends Error {}

const OPS = ['&&', '||', '2>>', '2>&1', '&>', '>>', '2>', '|', ';', '>', '<', '&', '\n'];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }

    // operators ("2>" only counts as an operator when it starts a token)
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { out.push({ t: 'op', op }); i += op.length; continue; }

    // word
    const word: Word = [];
    const start = i;
    let lit = '';
    const flush = (quoted: boolean) => {
      if (lit) { word.push({ kind: 'lit', value: lit, quoted }); lit = ''; }
    };
    const readVar = (quoted: boolean): boolean => {
      // at src[i] === '$'
      const rest = src.slice(i + 1);
      if (rest[0] === '{') {
        const close = rest.indexOf('}');
        if (close < 0) throw new Incomplete('unexpected EOF while looking for matching `}\'');
        const name = rest.slice(1, close);
        if (!/^([A-Za-z_][A-Za-z0-9_]*|[0-9?$#@*!])$/.test(name)) throw new SyntaxErr(`\${${name}}: bad substitution`);
        word.push({ kind: 'var', name, quoted });
        i += close + 2;
        return true;
      }
      const m = NAME_RE.exec(rest);
      if (m) { word.push({ kind: 'var', name: m[0], quoted }); i += 1 + m[0].length; return true; }
      if (rest[0] && '?$#@*!0123456789'.includes(rest[0])) {
        word.push({ kind: 'var', name: rest[0], quoted }); i += 2; return true;
      }
      if (rest[0] === '(') throw new SyntaxErr('command substitution $(...) is not supported');
      return false;
    };

    if (c === '~' ) {
      const nx = src[i + 1];
      if (nx === undefined || nx === '/' || /[\s;|&<>]/.test(nx)) { word.push({ kind: 'tilde' }); i++; }
    }

    while (i < n) {
      const ch = src[i];
      if (/[\s;|&<>]/.test(ch)) break;
      if (ch === '\\') {
        if (i + 1 >= n) throw new Incomplete('unexpected EOF after backslash');
        if (src[i + 1] === '\n') { i += 2; continue; }
        flush(false);
        word.push({ kind: 'lit', value: src[i + 1], quoted: true });
        i += 2;
        continue;
      }
      if (ch === "'") {
        const close = src.indexOf("'", i + 1);
        if (close < 0) throw new Incomplete("unexpected EOF while looking for matching `''");
        flush(false);
        word.push({ kind: 'lit', value: src.slice(i + 1, close), quoted: true });
        i = close + 1;
        continue;
      }
      if (ch === '"') {
        flush(false);
        i++;
        let closed = false;
        while (i < n) {
          const d = src[i];
          if (d === '"') { closed = true; i++; break; }
          if (d === '\\' && i + 1 < n && '$`"\\\n'.includes(src[i + 1])) {
            if (src[i + 1] !== '\n') lit += src[i + 1];
            i += 2; continue;
          }
          if (d === '$') {
            flush(true);
            if (readVar(true)) continue;
            lit += '$'; i++; continue;
          }
          if (d === '`') throw new SyntaxErr('command substitution `...` is not supported');
          lit += d; i++;
        }
        if (!closed) throw new Incomplete('unexpected EOF while looking for matching `"\'');
        flush(true);
        // keep an explicit empty segment so "" stays a word
        if (!word.length || word[word.length - 1].kind !== 'lit') word.push({ kind: 'lit', value: '', quoted: true });
        continue;
      }
      if (ch === '$') {
        flush(false);
        if (readVar(false)) continue;
        lit += '$'; i++; continue;
      }
      if (ch === '`') throw new SyntaxErr('command substitution `...` is not supported');
      lit += ch; i++;
    }
    flush(false);
    out.push({ t: 'word', word, raw: src.slice(start, i) });
  }
  return out;
}

/* ─────────────────────────── Parser ─────────────────────────── */

export function parse(src: string): ParseResult {
  let tokens: Token[];
  try {
    tokens = tokenize(src);
  } catch (e) {
    if (e instanceof Incomplete) return { ok: false, incomplete: true, message: e.message };
    return { ok: false, incomplete: false, message: (e as Error).message };
  }

  let p = 0;
  const peek = () => tokens[p];
  const isOp = (tok: Token | undefined, ...ops: string[]): boolean => !!tok && tok.t === 'op' && ops.includes(tok.op);
  const unexpected = (tok: Token | undefined) => {
    if (!tok) return new Incomplete('unexpected end of input');
    const s = tok.t === 'op' ? (tok.op === '\n' ? 'newline' : tok.op) : tok.raw;
    return new SyntaxErr(`syntax error near unexpected token \`${s}'`);
  };
  const skipNewlines = () => { while (isOp(peek(), '\n')) p++; };

  function command(): SimpleCommand {
    const cmd: SimpleCommand = { assigns: [], words: [], redirs: [] };
    for (;;) {
      const tok = peek();
      if (!tok) break;
      if (tok.t === 'op') {
        if (['>', '>>', '<', '2>', '2>>', '&>'].includes(tok.op)) {
          p++;
          const target = peek();
          if (!target || target.t !== 'word') throw unexpected(target ?? undefined);
          p++;
          cmd.redirs.push({ op: tok.op as RedirOp, target: target.word });
          continue;
        }
        if (tok.op === '2>&1') { p++; cmd.redirs.push({ op: '2>&1', target: null }); continue; }
        break;
      }
      // assignment only before the first word
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(tok.raw);
      const first = tok.word[0];
      if (!cmd.words.length && m && first && first.kind === 'lit' && !first.quoted && first.value.startsWith(m[0])) {
        const value: Word = [{ ...first, value: first.value.slice(m[0].length) }, ...tok.word.slice(1)];
        cmd.assigns.push({ name: m[1], value });
        p++;
        continue;
      }
      cmd.words.push(tok.word);
      p++;
    }
    if (!cmd.words.length && !cmd.assigns.length && !cmd.redirs.length) throw unexpected(peek());
    return cmd;
  }

  function pipeline(): Pipeline {
    let negate = false;
    const tok = peek();
    if (tok && tok.t === 'word' && tok.raw === '!') { negate = true; p++; }
    const cmds = [command()];
    while (isOp(peek(), '|')) {
      p++;
      skipNewlines();
      if (!peek()) throw new Incomplete('pipe continues');
      cmds.push(command());
    }
    return { negate, cmds };
  }

  function andor(): AndOr {
    const first = pipeline();
    const rest: AndOr['rest'] = [];
    for (;;) {
      const tok = peek();
      if (!isOp(tok, '&&', '||')) break;
      p++;
      skipNewlines();
      if (!peek()) throw new Incomplete('list continues');
      rest.push({ op: (tok as { op: '&&' | '||' }).op, pipeline: pipeline() });
    }
    return { first, rest };
  }

  try {
    const script: Script = [];
    skipNewlines();
    while (p < tokens.length) {
      if (isOp(peek(), ';')) throw unexpected(peek());
      script.push(andor());
      const tok = peek();
      if (!tok) break;
      if (isOp(tok, '&')) throw new SyntaxErr('background jobs (&) are not supported');
      if (isOp(tok, ';', '\n')) { p++; skipNewlines(); continue; }
      throw unexpected(tok);
    }
    return { ok: true, script };
  } catch (e) {
    if (e instanceof Incomplete) return { ok: false, incomplete: true, message: e.message };
    return { ok: false, incomplete: false, message: (e as Error).message };
  }
}

/** Turns a word back into the raw text the user would see (for debugging / tests). */
export function wordToString(w: Word): string {
  return w.map((s) => (s.kind === 'lit' ? s.value : s.kind === 'var' ? `$${s.name}` : '~')).join('');
}
