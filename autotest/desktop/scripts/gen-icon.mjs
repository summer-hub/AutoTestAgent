// 生成桌面端图标源图（1024×1024 PNG）：深蓝→青渐变底 + 白色几何 "A" 标记。
// 纯 Node 实现（zlib 编码 PNG），不引入任何依赖；随后由 `tauri icon` 产出各尺寸/ico/icns。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 1024;
const H = 1024;

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 画面 ----------
const C1 = { r: 23, g: 37, b: 84 };    // 深蓝 #172554
const C2 = { r: 13, g: 148, b: 136 };  // 青 #0d9488
const lerp = (a, b, t) => a + (b - a) * t;

// "A"：外三角形 − 内三角镂空 − 横梁
const T1 = { x: 512, y: 168 };
const T2 = { x: 208, y: 856 };
const T3 = { x: 816, y: 856 };
const I1 = { x: 512, y: 338 };
const I2 = { x: 302, y: 726 };
const I3 = { x: 722, y: 726 };
const BAR = { x0: 392, x1: 632, y0: 556, y1: 616 };

function sign(p, a, b) { return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y); }
function inTriangle(p, a, b, c) {
  const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
  return !(((d1 > 0) || (d2 > 0) || (d3 > 0)) && ((d1 < 0) || (d2 < 0) || (d3 < 0)));
}

const px = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    // 对角渐变 + 中心微亮
    const t = Math.min(1, Math.max(0, (x / W) * 0.62 + (y / H) * 0.38));
    const glow = Math.max(0, 1 - Math.hypot(x - 512, y - 470) / 620) * 0.16;
    let r = lerp(C1.r, C2.r, t) + 255 * glow;
    let g = lerp(C1.g, C2.g, t) + 255 * glow;
    let b = lerp(C1.b, C2.b, t) + 255 * glow;
    let a = 255;
    // 圆角方形象限限定的品牌区
    const inMark = inTriangle({ x, y }, T1, T2, T3)
      && !inTriangle({ x, y }, I1, I2, I3)
      && !(x >= BAR.x0 && x <= BAR.x1 && y >= BAR.y0 && y <= BAR.y1);
    if (inMark) { r = 245; g = 250; b = 255; }
    px[i] = Math.min(255, r);
    px[i + 1] = Math.min(255, g);
    px[i + 2] = Math.min(255, b);
    px[i + 3] = a;
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodePng(W, H, px));
console.log('[icon] source ->', out);
