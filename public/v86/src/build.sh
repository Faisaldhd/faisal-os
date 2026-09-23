#!/bin/sh
# Rebuilds public/v86/bzImage (Linux 6.8 i686 + BusyBox initramfs) from Ubuntu 24.04 packages.
# Needs: an Ubuntu/Debian host with `dpkg --add-architecture i386`, gcc, make, flex, bison, bc, libelf-dev.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-/tmp/faisal-v86-build}
mkdir -p "$WORK" && cd "$WORK"

apt-get download linux-source-6.8.0 busybox-static:i386
dpkg-deb -x linux-source-6.8.0_*.deb ksrc
dpkg-deb -x busybox-static_*_i386.deb bb
tar xjf ksrc/usr/src/linux-source-6.8.0/linux-source-6.8.0.tar.bz2

sed -e "s|@BUSYBOX@|$WORK/bb/usr/bin/busybox|" -e "s|@ROOTFS@|$HERE/rootfs|" \
  "$HERE/initramfs.list.in" > "$WORK/initramfs.list"

cd linux-source-6.8.0
cp "$HERE/kernel.config" .config
sed -i "s|^CONFIG_INITRAMFS_SOURCE=.*|CONFIG_INITRAMFS_SOURCE=\"$WORK/initramfs.list\"|" .config
make ARCH=i386 olddefconfig
make ARCH=i386 -j"$(nproc)" bzImage
cp arch/x86/boot/bzImage "$HERE/../bzImage"
echo "done: $HERE/../bzImage"
