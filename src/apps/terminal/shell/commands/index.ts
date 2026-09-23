import type { CommandContext, CommandSpec } from '../types';
import { C, columns } from '../util';
import { fsCommands } from './fs';
import { faisalCommands } from './faisal';
import { sysCommands } from './sys';
import { textCommands } from './text';

const GROUPS: [CommandSpec['group'], string][] = [
  ['files', 'Files'],
  ['text', 'Text'],
  ['system', 'System'],
  ['shell', 'Shell'],
  ['faisal', 'Faisal'],
];

function help(ctx: CommandContext): number {
  const tty = ctx.isTTY;
  const b = (s: string) => (tty ? C.bold + s + C.reset : s);
  const topic = ctx.args[0];
  if (topic) {
    const spec = defaultCommands[topic];
    if (!spec) { ctx.err(`help: no help topics match '${topic}'\n`); return 1; }
    ctx.out(`${b(topic)} - ${spec.help}\n`);
    return 0;
  }
  let out = `${b('Faisal shell')} (bash-like). Type ${b('help NAME')} for one command.\n` +
    `Pipes |, redirects > >> < 2>, && || ;, quotes, $VARS, ~ and * globs work.\n` +
    `Keys: Tab completes, Up/Down history, Ctrl+C cancels, Ctrl+L clears, Ctrl+A/E/U/K/W edit.\n`;
  const cols = ctx.shell.host.size?.().cols ?? 80;
  for (const [g, title] of GROUPS) {
    const names = Object.keys(defaultCommands).filter((n) => defaultCommands[n].group === g && !defaultCommands[n].help.startsWith('hint'));
    if (!names.length) continue;
    out += `\n${tty ? C.boldBlue : ''}${title}${tty ? C.reset : ''}\n`;
    out += columns(names.sort().map((n) => ({ text: n, width: n.length })), cols);
  }
  out += `\nYou are an unprivileged user: you can write in ~ and /tmp only.\n` +
    `Run ${b('linux')} to boot a real Linux kernel in an emulator.\n`;
  ctx.out(out);
  return 0;
}

export const defaultCommands: Record<string, CommandSpec> = {
  ...fsCommands,
  ...textCommands,
  ...sysCommands,
  ...faisalCommands,
  help: { run: help, group: 'shell', builtin: true, help: 'list commands' },
};
