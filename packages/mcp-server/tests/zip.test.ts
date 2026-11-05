import { describe, expect, it } from 'vitest';
import { buildZip, crc32 } from '../src/zip.js';

describe('buildZip（零依赖 ZIP 打包器）', () => {
  it('crc32 符合标准校验值（"123456789" → 0xCBF43929）', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926); // 与 zlib 一致
  });

  it('生成的 ZIP 结构合法，声明的 CRC 与内容一致', () => {
    const entries = [
      { name: 'SKILL.md', data: Buffer.from('---\nname: test\nversion: 1.1.0\n---\n内容', 'utf8') },
      { name: 'references/priority-standard.md', data: Buffer.from('# 优先级', 'utf8') },
    ];
    const zip = buildZip(entries);
    expect(zip.subarray(0, 2).toString()).toBe('PK');

    let off = 0;
    const seen: Array<{ name: string; crc: number; data: Buffer }> = [];
    while (zip.readUInt32LE(off) === 0x04034b50) {
      const flags = zip.readUInt16LE(off + 6);
      expect(flags & 0x0800).toBe(0x0800); // UTF-8 文件名标志
      expect(zip.readUInt16LE(off + 8)).toBe(0); // method: store
      const crc = zip.readUInt32LE(off + 14);
      const size = zip.readUInt32LE(off + 18);
      const nameLen = zip.readUInt16LE(off + 26);
      const extraLen = zip.readUInt16LE(off + 28);
      const name = zip.subarray(off + 30, off + 30 + nameLen).toString('utf8');
      const dataStart = off + 30 + nameLen + extraLen;
      seen.push({ name, crc, data: zip.subarray(dataStart, dataStart + size) });
      off += 30 + nameLen + extraLen + size;
    }
    expect(seen.map((s) => s.name)).toEqual(entries.map((e) => e.name));
    for (const s of seen) {
      expect(s.crc).toBe(crc32(s.data)); // 此前 CRC 表生成写错导致全错，回归锁定
      expect(s.data.toString('utf8')).toBe(entries.find((e) => e.name === s.name)!.data.toString('utf8'));
    }
  });
});
