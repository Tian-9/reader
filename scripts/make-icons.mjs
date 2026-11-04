#!/usr/bin/env node
// 生成占位 PWA 图标（public/icon-192.png、icon-512.png）。纯 Node，不依赖图形库。
// 画面：米色底 + 一本摊开的书（两页 + 书脊）。只是占位，好不好看她说了算，要换直接替换这两个 png。
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0xf7, 0xf3, 0xea];
const PAGE = [0xff, 0xfd, 0xf8];
const INK = [0xb5, 0x56, 0x2b];
const LINE = [0xd9, 0xcf, 0xbd];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const s = size / 512; // 按 512 设计，缩放
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const X = x / s, Y = y / s;
      let col = BG;
      // 两页：左页 x 96-252，右页 260-416，y 140-372，外侧下角略翘
      const inLeft = X >= 96 && X < 252 && Y >= 140 + (252 - X) * 0.08 && Y < 372;
      const inRight = X >= 260 && X < 416 && Y >= 140 + (X - 260) * 0.08 && Y < 372;
      if (inLeft || inRight) {
        col = PAGE;
        // 横线（文字行）
        const lx0 = inLeft ? 120 : 284, lx1 = inLeft ? 232 : 396;
        for (let ly = 190; ly <= 330; ly += 28) if (X >= lx0 && X < lx1 && Y >= ly && Y < ly + 6) col = LINE;
        // 右页一个划线的词
        if (inRight && X >= 284 && X < 350 && Y >= 246 && Y < 252) col = INK;
      }
      // 书脊
      if (X >= 252 && X < 260 && Y >= 136 && Y < 380) col = INK;
      // 书底边
      if (X >= 96 && X < 416 && Y >= 372 && Y < 384) col = INK;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = col[0]; raw[o + 1] = col[1]; raw[o + 2] = col[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  writeFileSync(`public/icon-${size}.png`, png(size));
  console.log(`public/icon-${size}.png`);
}
