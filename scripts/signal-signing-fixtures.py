#!/usr/bin/env python3
"""Build tiny, account-free Mach-O/PE fixtures in the test container."""
import pathlib
import struct
import sys
root = pathlib.Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
# arm64 Mach-O executable with one real RET instruction and ample header padding.
b = bytearray(8192)
struct.pack_into('<8I', b, 0, 0xfeedfacf, 0x100000c, 0, 2, 3, 248, 0x200085, 0)
struct.pack_into('<II16sQQQQIIII', b, 32, 0x19, 152, b'__TEXT', 0x100000000, 8192, 0, 8192, 7, 5, 1, 0)
struct.pack_into('<16s16sQQIIIIIIII', b, 104, b'__text', b'__TEXT', 0x100001000, 4, 4096, 2, 0, 0, 0x80000400, 0, 0, 0)
struct.pack_into('<II16sQQQQIIII', b, 184, 0x19, 72, b'__LINKEDIT', 0x100002000, 0, 8192, 0, 7, 1, 0, 0)
struct.pack_into('<IIQQ', b, 256, 0x80000028, 24, 4096, 0)
struct.pack_into('<I', b, 4096, 0xd65f03c0)
(root/'original.macho').write_bytes(b)
# PE32+ x64 executable with XOR EAX,EAX; RET in its sole .text section.
b = bytearray(1024); b[:2] = b'MZ'; struct.pack_into('<I', b, 60, 128)
b[128:132] = b'PE\0\0'
struct.pack_into('<HHIIIHH', b, 132, 0x8664, 1, 0, 0, 0, 240, 0x22)
o = 152
struct.pack_into('<H', b, o, 0x20b)
struct.pack_into('<I', b, o+4, 512)
struct.pack_into('<IIQ', b, o+16, 4096, 4096, 0x140000000)
struct.pack_into('<II', b, o+32, 4096, 512)
struct.pack_into('<HH', b, o+40, 6, 0)
struct.pack_into('<HH', b, o+48, 6, 0)
struct.pack_into('<II', b, o+56, 8192, 512)
struct.pack_into('<HH', b, o+68, 3, 0x160)
struct.pack_into('<QQQQII', b, o+72, 1048576, 4096, 1048576, 4096, 0, 16)
struct.pack_into('<8sIIIIIIHHI', b, 392, b'.text', 3, 4096, 512, 512, 0, 0, 0, 0, 0x60000020)
b[512:515] = b'\x31\xc0\xc3'
(root/'original.exe').write_bytes(b)
