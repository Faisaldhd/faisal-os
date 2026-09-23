import type { TerminalBackend } from '../../../kernel/types';

/** Files expected under public/v86/ (see public/v86/README.md). */
export const V86_ASSETS = { bios: 'seabios.bin', vgaBios: 'vgabios.bin', kernel: 'bzImage' } as const;

export interface V86Messages {
  loading: string;
  booting: string;
  missing: (files: string[], dir: string) => string;
  failed: (err: string) => string;
}

export interface V86BackendOptions {
  /** Directory URL holding the assets, e.g. new URL('v86/', document.baseURI). */
  assetsBase: string;
  messages: V86Messages;
  memoryMB?: number;
  /** Terminal size at boot; the VM applies it with `stty` (serial ports have no window size). */
  size?: () => { cols: number; rows: number };
  onStatus?: (s: V86Status) => void;
}

export type V86Status = 'loading' | 'booting' | 'running' | 'missing' | 'failed';

interface Emulator {
  add_listener(ev: string, fn: (arg: never) => void): void;
  serial_send_bytes(port: number, data: Uint8Array): void;
  destroy(): Promise<void>;
}

const CMDLINE = 'console=ttyS0,115200 tsc=reliable random.trust_cpu=on loglevel=4';

/**
 * Real Linux in the browser via the v86 x86 emulator. The kernel's serial
 * console (ttyS0) is wired to xterm. No network device is attached.
 */
export class V86Backend implements TerminalBackend {
  readonly kind = 'v86' as const;
  private emulator: Emulator | null = null;
  private output: (s: string) => void = () => {};
  private disposed = false;
  private decoder = new TextDecoder('utf-8');
  private bytes: number[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private gotOutput = false;
  private encoder = new TextEncoder();

  constructor(private opts: V86BackendOptions) {}

  async start(output: (data: string) => void): Promise<void> {
    this.output = output;
    const m = this.opts.messages;
    const base = this.opts.assetsBase.endsWith('/') ? this.opts.assetsBase : this.opts.assetsBase + '/';
    const status = (st: V86Status) => { if (!this.disposed) this.opts.onStatus?.(st); };
    status('loading');
    output(`\x1b[2m${m.loading}\x1b[0m\r\n`);

    const missing: string[] = [];
    await Promise.all(Object.values(V86_ASSETS).map(async (f) => {
      try {
        const r = await fetch(base + f, { method: 'HEAD', cache: 'no-cache' });
        const type = r.headers.get('content-type') ?? '';
        // dev servers answer unknown paths with index.html (200 text/html)
        if (!r.ok || type.includes('text/html')) missing.push(f);
      } catch { missing.push(f); }
    }));
    if (this.disposed) return;
    if (missing.length) { status('missing'); output(`\x1b[31m${m.missing(missing, base)}\x1b[0m\r\n`.replace(/\n/g, '\r\n').replace(/\r\r/g, '\r')); return; }

    try {
      const [{ V86 }, wasm] = await Promise.all([
        import('v86'),
        import('v86/build/v86.wasm?url'),
      ]);
      if (this.disposed) return;
      status('booting');
      output(`\x1b[2m${m.booting}\x1b[0m\r\n`);
      const emu = new V86({
        wasm_path: wasm.default,
        bios: { url: base + V86_ASSETS.bios },
        vga_bios: { url: base + V86_ASSETS.vgaBios },
        bzimage: { url: base + V86_ASSETS.kernel },
        cmdline: this.cmdline(),
        memory_size: (this.opts.memoryMB ?? 64) * 1024 * 1024,
        vga_memory_size: 2 * 1024 * 1024,
        autostart: true,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
        acpi: false,
        screen_container: null,
      } as ConstructorParameters<typeof V86>[0]) as unknown as Emulator;
      this.emulator = emu;
      emu.add_listener('serial0-output-byte', ((b: number) => this.onByte(b)) as (arg: never) => void);
    } catch (e) {
      status('failed');
      output(`\x1b[31m${m.failed(String((e as Error)?.message ?? e))}\x1b[0m\r\n`);
    }
  }

  private cmdline(): string {
    const size = this.opts.size?.();
    if (!size) return CMDLINE;
    const cols = Math.max(20, Math.min(500, Math.floor(size.cols)));
    const rows = Math.max(5, Math.min(300, Math.floor(size.rows)));
    return `${CMDLINE} faisal.cols=${cols} faisal.rows=${rows}`;
  }

  private onByte(b: number): void {
    if (this.disposed) return;
    this.bytes.push(b);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 8);
  }

  private flush(): void {
    this.flushTimer = null;
    if (!this.bytes.length || this.disposed) return;
    const chunk = new Uint8Array(this.bytes);
    this.bytes = [];
    if (!this.gotOutput) { this.gotOutput = true; this.opts.onStatus?.('running'); }
    this.output(this.decoder.decode(chunk, { stream: true }));
  }

  input(data: string): void {
    if (!this.emulator || this.disposed) return;
    // xterm sends DEL for Backspace; the serial tty expects the same. UTF-8 goes as bytes.
    this.emulator.serial_send_bytes(0, this.encoder.encode(data));
  }

  resize(): void {
    // A serial console has no window-size signal; `stty cols N rows M` inside the VM adjusts it.
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const emu = this.emulator;
    this.emulator = null;
    if (emu) void emu.destroy().catch(() => {});
  }
}
