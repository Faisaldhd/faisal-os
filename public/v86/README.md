# Linux VM assets for the Terminal (v86)

The Terminal's "Linux (v86)" session boots these files in the v86 emulator.
The kernel console is on the first serial port (ttyS0), which is connected to xterm.
The VM has no network card and no disk. Everything lives in RAM and is lost when you close it.

| File | Size | What it is | Source / license |
| --- | --- | --- | --- |
| `bzImage` | 1.7 MB | Linux 6.8.12, i686, tiny config, with a built-in initramfs holding BusyBox 1.36.1 (static) and the small `/etc` in `src/rootfs` | Kernel: Ubuntu 24.04 `linux-source-6.8.0` 6.8.0-142.142 (GPL-2.0). BusyBox: Ubuntu `busybox-static` 1:1.36.1-6ubuntu3.1, i386 (GPL-2.0). The corresponding sources are those Ubuntu packages, and their source packages are on archive.ubuntu.com. |
| `seabios.bin` | 128 KB | PC BIOS | SeaBIOS (LGPL-3.0), taken from github.com/copy/v86 `bios/` |
| `vgabios.bin` | 36 KB | VGA BIOS | SeaVGABIOS (LGPL-3.0), taken from github.com/copy/v86 `bios/` |

The emulator (`libv86.mjs` and `v86.wasm`, BSD-2-Clause) comes from the `v86` npm package, and Vite bundles it.

## Rebuilding `bzImage`

Run `src/build.sh` on an Ubuntu 24.04 host with the i386 architecture enabled.
It downloads the two Ubuntu packages, writes the initramfs from `src/initramfs.list.in` and `src/rootfs/`, and builds with `src/kernel.config`.
`src/kernel-fragment.config` lists the options that were added on top of `make tinyconfig`.

## Using a different image

Any 32-bit x86 `bzImage` works if it:
- has an 8250 serial console built in (`CONFIG_SERIAL_8250_CONSOLE=y`), and
- carries its own initramfs, or boots to a shell without a disk.

The Terminal passes `console=ttyS0,115200` on the kernel command line.
If `bzImage`, `seabios.bin` or `vgabios.bin` is missing, the Terminal tells you which file is missing and the Faisal shell keeps working.
