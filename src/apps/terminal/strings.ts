import { defineStrings } from '../../kernel/i18n';

defineStrings('terminal', {
  ar: {
    name: 'الطرفية',
    backend: 'الجلسة',
    sim: 'صدفة فيصل',
    v86: 'لينكس (v86)',
    restart: 'إعادة التشغيل',
    statusSim: 'صدفة مدمجة فورية',
    statusLoading: 'جارٍ تحميل محاكي v86…',
    statusBooting: 'جارٍ إقلاع لينكس حقيقي… (بضع ثوانٍ)',
    statusRunning: 'لينكس حقيقي داخل المتصفح، بلا شبكة، في الذاكرة فقط',
    statusMissing: 'ملفات لينكس غير موجودة في public/v86',
    statusFailed: 'تعذّر تشغيل المحاكي',
  },
  en: {
    name: 'Terminal',
    backend: 'Session',
    sim: 'Faisal shell',
    v86: 'Linux (v86)',
    restart: 'Restart',
    statusSim: 'Built-in instant shell',
    statusLoading: 'Loading the v86 emulator…',
    statusBooting: 'Booting real Linux… (a few seconds)',
    statusRunning: 'Real Linux in your browser: no network, RAM only',
    statusMissing: 'Linux files are missing from public/v86',
    statusFailed: 'The emulator could not start',
  },
});

/** Messages written inside xterm stay in English: xterm.js does not shape or reorder Arabic text. */
export const TERM_TEXT = {
  banner: "Welcome to \x1b[1mFai$al OS\x1b[0m. Type \x1b[1mhelp\x1b[0m to see the commands, or \x1b[1mlinux\x1b[0m to boot a real Linux kernel.\n\n",
  v86Loading: 'Loading the v86 x86 emulator...',
  v86Booting: 'Booting Linux over the serial console (ttyS0). This takes a few seconds...',
  v86Missing: (files: string[], dir: string) =>
    `Cannot start the Linux VM: missing ${files.join(', ')} in ${dir}\n` +
    'Put seabios.bin, vgabios.bin and a bzImage (serial console on ttyS0) in public/v86/.\n' +
    'See public/v86/README.md. Switch back to "Faisal shell" from the header to keep working.',
  v86Failed: (err: string) => `The emulator failed to start: ${err}`,
};
