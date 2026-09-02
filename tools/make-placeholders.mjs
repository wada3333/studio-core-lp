/**
 * assets/images/ のプレースホルダ WebP を生成するスクリプト
 * ---------------------------------------------------------------------------
 *   node tools/make-placeholders.mjs
 *
 * 外部依存なしで単色の可逆 WebP（VP8L）を書き出します。1ファイル 30 バイト前後。
 * README 記載のプロンプトで本番画像を生成したら、同じファイル名・同じ縦横比で
 * 上書きしてください（HTML の width / height 属性も同じ値にしてあります）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'images');

/** VP8L はビットを各バイトの下位側から詰める（LSB first） */
class BitWriter {
  constructor() {
    this.bytes = [];
    this.cur = 0;
    this.nbits = 0;
  }
  put(value, bits) {
    for (let i = 0; i < bits; i++) {
      this.cur |= ((value >> i) & 1) << this.nbits;
      this.nbits++;
      if (this.nbits === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }
  finish() {
    if (this.nbits > 0) this.bytes.push(this.cur);
    return Buffer.from(this.bytes);
  }
}

/** 単一シンボルのハフマン符号（simple code）を書く。復号時 0 ビットで確定する。 */
function putSingleSymbolCode(bw, symbol) {
  bw.put(1, 1); // simple code length code
  bw.put(0, 1); // num_symbols - 1 = 0
  bw.put(1, 1); // first symbol is 8 bits
  bw.put(symbol, 8);
}

function solidWebp(width, height, [r, g, b, a = 255]) {
  const bw = new BitWriter();
  bw.put(0x2f, 8); // VP8L signature
  bw.put(width - 1, 14);
  bw.put(height - 1, 14);
  bw.put(1, 1); // alpha_is_used
  bw.put(0, 3); // version
  bw.put(0, 1); // transform なし
  bw.put(0, 1); // color cache なし
  bw.put(0, 1); // meta huffman なし
  putSingleSymbolCode(bw, g); // green
  putSingleSymbolCode(bw, r); // red
  putSingleSymbolCode(bw, b); // blue
  putSingleSymbolCode(bw, a); // alpha
  putSingleSymbolCode(bw, 0); // distance
  const payload = bw.finish();
  const padded = payload.length % 2 === 1 ? Buffer.concat([payload, Buffer.alloc(1)]) : payload;

  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(4 + 8 + padded.length, 4);
  head.write('WEBP', 8, 'ascii');
  head.write('VP8L', 12, 'ascii');
  head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, padded]);
}

const FILES = [
  ['hero.webp', 1600, 893, [0xd6, 0xdc, 0xd8]],
  ['reason-1.webp', 1200, 896, [0xdb, 0xe0, 0xdc]],
  ['reason-2.webp', 1200, 896, [0xd2, 0xd9, 0xd5]],
  ['reason-3.webp', 1200, 896, [0xdf, 0xe3, 0xdf]],
  ['trainer-1.webp', 600, 600, [0xd8, 0xde, 0xda]],
  ['trainer-2.webp', 600, 600, [0xd2, 0xd9, 0xd5]],
  ['trainer-3.webp', 600, 600, [0xdd, 0xe2, 0xde]]
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, w, h, rgb] of FILES) {
  const buf = solidWebp(w, h, rgb);
  writeFileSync(join(OUT_DIR, name), buf);
  console.log(`${name}  ${w}x${h}  ${buf.length} bytes`);
}
