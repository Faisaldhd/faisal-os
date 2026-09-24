import type { ProcessInfo, ProcessSignal, VFS } from '../../../kernel/types';

/** Things the shell asks the hosting terminal/OS to do. All optional so tests can omit them. */
export interface ShellHost {
  clear?(): void;
  exit?(): void;
  /** Switch the terminal to another backend (e.g. the real Linux VM). */
  switchBackend?(kind: 'v86'): void;
  /** Opens a file or directory with the right app. Returns false when no app matches. */
  open?(path: string, isDir: boolean): Promise<boolean>;
  /** Installed apps, for `dnf list`. */
  listApps?(): { id: string; name: string }[];
  /** The kernel's process table (src/kernel/process.ts), for `ps`, `top` and `kill`. */
  processes?(includeExited: boolean): ProcessInfo[];
  /** Signals a process: 0 on success, 1 when there is no such process or it is protected. */
  signalProcess?(pid: number, signal: ProcessSignal): number;
  /** Window title (GNOME Console shows the working directory). */
  setTitle?(title: string): void;
  /** Terminal size. */
  size?(): { cols: number; rows: number };
}

export interface CancelSignal { readonly cancelled: boolean }

export interface CommandContext {
  /** argv without the command name. */
  args: string[];
  /** Command name as typed (argv[0]). */
  name: string;
  /** Piped / redirected stdin, or null when reading from the terminal. */
  stdin: string | null;
  out(s: string): void;
  err(s: string): void;
  /** True when stdout goes straight to the terminal (colors, columns). */
  isTTY: boolean;
  signal: CancelSignal;
  shell: ShellLike;
}

/** The subset of the shell that commands may use. */
export interface ShellLike {
  cwd: string;
  readonly home: string;
  readonly user: string;
  readonly hostname: string;
  readonly vfs: VFS;
  readonly host: ShellHost;
  readonly startedAt: number;
  env: Map<string, string>;
  history: string[];
  resolve(p: string): string;
  /** Throws a ShellFsError-like VFSError(EACCES) if the path is not writable by "user". */
  assertWritable(path: string): void;
  commandNames(): string[];
  isBuiltin(name: string): boolean;
  /** Run a script (used by `source` / `sh file`). */
  runScript(src: string, ctx: CommandContext): Promise<number>;
}

export type Command = (ctx: CommandContext) => Promise<number> | number;

export interface CommandSpec {
  run: Command;
  /** One-line help (English, like coreutils). */
  help: string;
  /** Category for `help`. */
  group: 'files' | 'text' | 'system' | 'faisal' | 'shell';
  /** Built-ins mutate shell state (cd, export...). */
  builtin?: boolean;
}
