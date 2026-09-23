import { beforeEach, describe, expect, it } from 'vitest';
import { Shell, isUserWritable } from '../shell/shell';
import { complete } from '../shell/completer';
import { applyMode } from '../shell/commands/fs';
import { createMemVFS } from './memvfs';
import type { ShellHost } from '../shell/types';

let vfs: ReturnType<typeof createMemVFS>;
let sh: Shell;
let host: ShellHost & { opened: string[]; switched: string[]; exited: number };

async function run(cmd: string) {
  let out = '';
  let err = '';
  const status = await sh.run(cmd, { out: (s) => { out += s; }, err: (s) => { err += s; }, isTTY: false });
  return { out, err, status };
}

beforeEach(() => {
  vfs = createMemVFS({
    '/etc/os-release': 'NAME="Faisal OS"\nPRETTY_NAME="Faisal OS 1.0"\nID=faisal\n',
    '/home/user/notes.txt': 'banana\napple\ncherry\napple\n',
    '/home/user/Documents/report.md': '# Report\nhello world\nHello again\n',
    '/home/user/Documents/data.csv': 'a,1\nb,2\n',
    '/home/user/.hidden': 'secret\n',
    '/home/user/Pictures/': '',
    '/tmp/': '',
    '/usr/bin/': '',
  });
  host = {
    opened: [], switched: [], exited: 0,
    open: async (p) => { host.opened.push(p); return true; },
    switchBackend: (k) => { host.switched.push(k); },
    exit: () => { host.exited++; },
    listApps: () => [{ id: 'org.faisal.Files', name: 'Files' }, { id: 'org.faisal.Terminal', name: 'Terminal' }],
    size: () => ({ cols: 80, rows: 24 }),
  };
  sh = new Shell({ vfs, host });
});

describe('expansion', () => {
  it('expands variables, $? and ~', async () => {
    expect((await run('echo $HOME $USER ~ ~/x')).out).toBe('/home/user user /home/user /home/user/x\n');
    await run('false');
    expect((await run('echo $?')).out).toBe('1\n');
    expect((await run('echo $?')).out).toBe('0\n');
  });

  it('supports VAR=x, export and prefix assignments', async () => {
    await run('GREETING="hi there"');
    expect((await run('echo "$GREETING!"')).out).toBe('hi there!\n');
    await run('export A=1 B');
    expect((await run('env')).out).toMatch(/^A=1$/m);
    expect((await run('X=5 env')).out).toMatch(/^X=5$/m);
    expect((await run('echo "[$X]"')).out).toBe('[]\n');
  });

  it('splits unquoted variables into fields', async () => {
    await run('FILES="a b"');
    expect((await run('printf-not-here 2>/dev/null; echo $FILES | wc -w')).out.trim()).toBe('2');
  });

  it('expands braces like bash', async () => {
    expect((await run('echo a{b,c}d {1..3} "{x,y}"')).out).toBe('abd acd 1 2 3 {x,y}\n');
    await run('touch f{1,2}.txt');
    expect((await run('ls f*')).out).toBe('f1.txt\nf2.txt\n');
  });

  it('expands globs sorted, keeping literals when nothing matches', async () => {
    expect((await run('echo Documents/*')).out).toBe('Documents/data.csv Documents/report.md\n');
    expect((await run('echo *.txt')).out).toBe('notes.txt\n');
    expect((await run('echo *.nope')).out).toBe('*.nope\n');
    expect((await run("echo '*'")).out).toBe('*\n');
    expect((await run('echo /home/user/D*/*.md')).out).toBe('/home/user/Documents/report.md\n');
  });
});

describe('pipes and redirects', () => {
  it('pipes output between commands', async () => {
    expect((await run('cat notes.txt | sort | uniq')).out).toBe('apple\nbanana\ncherry\n');
    expect((await run('cat notes.txt | sort | uniq -c | sort -rn | head -n 1')).out).toBe('      2 apple\n');
    expect((await run('cat notes.txt | grep an | wc -l')).out.trim()).toBe('1');
  });

  it('redirects with > >> < and 2>', async () => {
    await run('echo one > out.txt');
    await run('echo two >> out.txt');
    expect(await vfs.readText('/home/user/out.txt')).toBe('one\ntwo\n');
    expect((await run('wc -l < out.txt')).out.trim()).toBe('2');
    const r = await run('cat missing 2> err.txt');
    expect(r.err).toBe('');
    expect(r.status).toBe(1);
    expect(await vfs.readText('/home/user/err.txt')).toBe('cat: missing: No such file or directory\n');
    await run('cat missing > both.txt 2>&1');
    expect(await vfs.readText('/home/user/both.txt')).toContain('No such file');
    expect((await run('echo gone > /dev/null')).out).toBe('');
  });

  it('refuses to redirect outside home and /tmp', async () => {
    const r = await run('echo x > /etc/hack');
    expect(r.err).toBe('bash: /etc/hack: Permission denied\n');
    expect(r.status).toBe(1);
    expect(await vfs.exists('/etc/hack')).toBe(false);
    await run('echo ok > /tmp/t');
    expect(await vfs.readText('/tmp/t')).toBe('ok\n');
  });

  it('hofaisals && || ; and !', async () => {
    expect((await run('true && echo yes || echo no')).out).toBe('yes\n');
    expect((await run('false && echo yes || echo no')).out).toBe('no\n');
    expect((await run('echo a; echo b')).out).toBe('a\nb\n');
    expect((await run('! false && echo neg')).out).toBe('neg\n');
  });
});

describe('commands', () => {
  it('reports unknown commands and syntax errors like bash', async () => {
    expect(await run('nosuchcmd')).toEqual({ out: '', err: 'bash: nosuchcmd: command not found\n', status: 127 });
    const r = await run('echo |');
    expect(r.status).toBe(2);
  });

  it('cd / pwd / cd - / errors', async () => {
    await run('cd Documents');
    expect((await run('pwd')).out).toBe('/home/user/Documents\n');
    expect((await run('cd -')).out).toBe('/home/user\n');
    expect((await run('cd nope')).err).toBe('bash: cd: nope: No such file or directory\n');
    expect((await run('cd notes.txt')).err).toBe('bash: cd: notes.txt: Not a directory\n');
    await run('cd /');
    expect(sh.cwd).toBe('/');
    await run('cd');
    expect(sh.cwd).toBe('/home/user');
  });

  it('ls lists, hides dotfiles, -a, -l and errors', async () => {
    expect((await run('ls')).out).toBe('Documents\nnotes.txt\nPictures\n');
    expect((await run('ls -a')).out).toContain('.hidden');
    const l = (await run('ls -l Documents')).out;
    expect(l).toMatch(/^total \d+$/m);
    expect(l).toMatch(/-rw-r--r--\. 1 user user\s+8 .* data\.csv$/m);
    const e = await run('ls nope');
    expect(e.err).toBe("ls: cannot access 'nope': No such file or directory\n");
    expect(e.status).toBe(2);
    expect((await run('ls -l /etc')).out).toMatch(/root root/);
  });

  it('ls shows colors only on a tty', async () => {
    let out = '';
    await sh.run('ls', { out: (s) => { out += s; }, err: () => {}, isTTY: true });
    expect(out).toContain('\x1b[1;34mDocuments\x1b[0m');
  });

  it('never prints raw control characters from file names', async () => {
    await vfs.writeFile('/home/user/evil\x1b]0;x\x07', '');
    expect((await run('ls')).out).toContain('evil?]0;x?');
  });

  it('mkdir -p, touch, cp -r, mv, rm -r, rmdir', async () => {
    expect((await run('mkdir a/b')).err).toBe("mkdir: cannot create directory 'a/b': No such file or directory\n");
    await run('mkdir -p a/b/c && touch a/b/c/f.txt && echo hi > a/x');
    expect(await vfs.exists('/home/user/a/b/c/f.txt')).toBe(true);
    expect((await run('mkdir a')).err).toBe("mkdir: cannot create directory 'a': File exists\n");
    expect((await run('cp a b')).err).toBe("cp: -r not specified; omitting directory 'a'\n");
    await run('cp -r a b');
    expect(await vfs.readText('/home/user/b/x')).toBe('hi\n');
    await run('cp notes.txt Documents');
    expect(await vfs.exists('/home/user/Documents/notes.txt')).toBe(true);
    await run('mv b c');
    expect(await vfs.exists('/home/user/b')).toBe(false);
    expect(await vfs.exists('/home/user/c/b/c/f.txt')).toBe(true);
    await run('mv notes.txt renamed.txt');
    expect(await vfs.exists('/home/user/renamed.txt')).toBe(true);
    expect((await run('rm c')).err).toBe("rm: cannot remove 'c': Is a directory\n");
    expect((await run('rmdir a')).err).toBe("rmdir: failed to remove 'a': Directory not empty\n");
    await run('rm -r c');
    expect(await vfs.exists('/home/user/c')).toBe(false);
    expect((await run('rm -f nothing')).status).toBe(0);
    expect((await run('rm nothing')).err).toBe("rm: cannot remove 'nothing': No such file or directory\n");
  });

  it('acts as a non-root user outside home and /tmp', async () => {
    expect((await run('cat /etc/os-release')).out).toContain('PRETTY_NAME');
    expect((await run('touch /etc/x')).err).toBe("touch: cannot touch '/etc/x': Permission denied\n");
    expect((await run('rm /etc/os-release')).err).toBe("rm: cannot remove '/etc/os-release': Permission denied\n");
    expect((await run('mkdir /usr/bin/x')).err).toBe("mkdir: cannot create directory '/usr/bin/x': Permission denied\n");
    expect((await run('rm -rf /')).err).toContain('dangerous');
    expect((await run('mv /etc/os-release ~/')).err).toContain('Permission denied');
    expect((await run('cp /etc/os-release ~/copy')).status).toBe(0);
    expect(isUserWritable('/home/user/../../etc/x', '/home/user')).toBe(false);
    expect((await run('sudo ls')).status).toBe(1);
  });

  it('cat -n, head, tail, wc, grep, sort', async () => {
    expect((await run('cat -n Documents/data.csv')).out).toBe('     1\ta,1\n     2\tb,2\n');
    expect((await run('head -n 2 notes.txt')).out).toBe('banana\napple\n');
    expect((await run('tail -1 notes.txt')).out).toBe('apple\n');
    expect((await run('tail -n +3 notes.txt')).out).toBe('cherry\napple\n');
    expect((await run('wc notes.txt')).out).toBe(' 4  4 26 notes.txt\n');
    expect((await run('wc -l notes.txt')).out).toBe('4 notes.txt\n');
    expect((await run('grep -in hello Documents/report.md')).out).toBe('2:hello world\n3:Hello again\n');
    expect((await run('grep -v a notes.txt')).out).toBe('cherry\n');
    expect((await run('grep -c apple notes.txt')).out).toBe('2\n');
    expect((await run('grep zzz notes.txt')).status).toBe(1);
    expect((await run('grep -r hello .')).out).toBe('Documents/report.md:hello world\n');
    expect((await run('sort -r notes.txt')).out).toBe('cherry\nbanana\napple\napple\n');
    expect((await run('echo -e "3\\n10\\n2" | sort -n')).out).toBe('2\n3\n10\n');
  });

  it('echo -n / -e', async () => {
    expect((await run('echo -n hi')).out).toBe('hi');
    expect((await run('echo -e "a\\tb"')).out).toBe('a\tb\n');
    expect((await run('echo "a\\tb"')).out).toBe('a\\tb\n');
  });

  it('find, tree, stat, chmod, du, basename, dirname', async () => {
    expect((await run('find . -name "*.md"')).out).toBe('./Documents/report.md\n');
    expect((await run('find Documents -type f')).out).toBe('Documents/data.csv\nDocuments/report.md\n');
    const tree = (await run('tree Documents')).out;
    expect(tree).toBe('Documents\n├── data.csv\n└── report.md\n\n0 directories, 2 files\n');
    expect((await run('stat notes.txt')).out).toMatch(/Access: \(0644\/-rw-r--r--\)/);
    await run('chmod 755 notes.txt');
    expect((await vfs.stat('/home/user/notes.txt')).mode).toBe(0o755);
    await run('chmod go-x notes.txt');
    expect((await vfs.stat('/home/user/notes.txt')).mode).toBe(0o744);
    expect(applyMode('u+x', 0o644, false)).toBe(0o744);
    expect(applyMode('a=r', 0o755, false)).toBe(0o444);
    expect((await run('du -sh Documents')).out).toBe('4.0K\tDocuments\n');
    expect((await run('basename /a/b/c.txt .txt')).out).toBe('c\n');
    expect((await run('dirname /a/b/c.txt')).out).toBe('/a/b\n');
    expect((await run('df -h')).out).toMatch(/^Filesystem\s+Size/);
  });

  it('system info commands', async () => {
    expect((await run('whoami')).out).toBe('user\n');
    expect((await run('id')).out).toMatch(/^uid=1000\(user\)/);
    expect((await run('hostname')).out).toBe('faisal\n');
    expect((await run('uname -a')).out).toMatch(/^Faisal faisal /);
    expect((await run('date +%Y')).out).toBe(`${new Date().getFullYear()}\n`);
    expect((await run('cal 2 2024')).out).toContain('February 2024');
    expect((await run('cal 2 2024')).out).toContain('25 26 27 28 29');
    expect((await run('which ls')).out).toBe('/usr/bin/ls\n');
    expect((await run('which nope')).status).toBe(1);
    expect((await run('fastfetch')).out).toContain('Faisal OS 1.0');
    expect((await run('help')).out).toContain('Files');
  });

  it('history, dnf, open, linux, exit', async () => {
    sh.history.push('ls', 'pwd');
    expect((await run('history')).out).toBe('    1  ls\n    2  pwd\n');
    expect((await run('dnf list')).out).toContain('org.faisal.Files.noarch');
    expect((await run('dnf install vim')).status).toBe(1);
    await run('open notes.txt');
    expect(host.opened).toEqual(['/home/user/notes.txt']);
    expect((await run('open nope')).err).toBe('open: nope: No such file or directory\n');
    await run('linux');
    expect(host.switched).toEqual(['v86']);
    await run('exit');
    expect(host.exited).toBe(1);
  });

  it('runs executable scripts and source', async () => {
    await vfs.writeFile('/home/user/s.sh', 'echo from script\ncd Documents\n');
    expect((await run('./s.sh')).err).toBe('bash: ./s.sh: Permission denied\n');
    await run('chmod +x s.sh');
    expect((await run('./s.sh')).out).toBe('from script\n');
    expect((await run('sh -c "echo inner"')).out).toBe('inner\n');
  });

  it('sleep can be cancelled', async () => {
    const signal = { cancelled: false };
    const p = sh.run('sleep 5; echo after', { out: () => {}, err: () => {}, signal });
    setTimeout(() => { signal.cancelled = true; }, 50);
    const t0 = Date.now();
    expect(await p).toBe(130);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('keeps Arabic text intact', async () => {
    await run('echo "مرحبا بالعالم" > عربي.txt');
    expect((await run('cat عربي.txt')).out).toBe('مرحبا بالعالم\n');
    expect((await run('wc -m عربي.txt')).out).toBe('14 عربي.txt\n');
  });
});

describe('tab completion', () => {
  it('completes commands in command position', async () => {
    const r = await complete(sh, 'fastf', 5);
    expect(r.candidates).toEqual(['fastfetch']);
    const r2 = await complete(sh, 'ls | gr', 7);
    expect(r2.candidates).toEqual(['grep']);
  });

  it('completes paths and marks directories', async () => {
    expect((await complete(sh, 'cat Doc', 7)).candidates).toEqual(['Documents/']);
    expect((await complete(sh, 'cat Documents/r', 15)).candidates).toEqual(['Documents/report.md']);
    expect((await complete(sh, 'ls ', 3)).candidates).toEqual(['Documents/', 'notes.txt', 'Pictures/']);
    expect((await complete(sh, 'cd ~/Pic', 8)).candidates).toEqual(['~/Pictures/']);
  });

  it('completes $VARIABLES', async () => {
    expect((await complete(sh, 'echo $HO', 8)).candidates).toContain('$HOME');
  });
});
