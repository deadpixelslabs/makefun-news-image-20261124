interface FsModule {
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readFileSync(path: string): Buffer;
  statSync(path: string): { size: number };
  writeFileSync(path: string, data: Buffer): void;
}

interface PathModule {
  join(...paths: string[]): string;
}

const { mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs') as FsModule;
const { join } = require('node:path') as PathModule;

const MAX_BYTES = 1048576;
const MAX_DIMENSION = 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function verifyPngChunks(data: Buffer): { width: number; height: number } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;

  while (offset + 12 <= data.length) {
    const chunkLen = data.readUInt32BE(offset);
    const typeAndDataStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLen;
    if (dataEnd + 4 > data.length) {
      throw new Error(`Truncated PNG chunk at offset ${offset}`);
    }
    const chunkType = data.subarray(typeAndDataStart, dataStart).toString('ascii');
    const expectedCrc = data.readUInt32BE(dataEnd);
    const actualCrc = crc32(data.subarray(typeAndDataStart, dataEnd));
    if (actualCrc !== expectedCrc) {
      throw new Error(`PNG CRC mismatch in chunk ${chunkType}`);
    }

    if (chunkType === 'IHDR') {
      if (chunkLen !== 13) throw new Error(`Invalid IHDR length: ${chunkLen}`);
      width = data.readUInt32BE(dataStart);
      height = data.readUInt32BE(dataStart + 4);
      sawIhdr = true;
    } else if (chunkType === 'IDAT') {
      sawIdat = true;
    } else if (chunkType === 'IEND') {
      if (chunkLen !== 0) throw new Error(`Invalid IEND length: ${chunkLen}`);
      sawIend = true;
      offset = dataEnd + 4;
      break;
    }
    offset = dataEnd + 4;
  }

  if (!sawIhdr || !sawIdat || !sawIend || offset !== data.length) {
    throw new Error('Incomplete PNG stream or trailing bytes after IEND');
  }
  return { width, height };
}

function validateImageArtifact(data: Buffer): { format: 'png' | 'jpeg'; width: number; height: number } {
  if (data.length >= 24 && data.subarray(0, 8).equals(PNG_MAGIC)) {
    const dims = verifyPngChunks(data);
    return { format: 'png', width: dims.width, height: dims.height };
  }

  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    if (data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
      throw new Error('JPEG missing trailing EOI marker');
    }
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = data[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segmentLen = data.readUInt16BE(offset + 2);
      if ((marker === 0xc0 || marker === 0xc2) && offset + 9 <= data.length) {
        return {
          format: 'jpeg',
          height: data.readUInt16BE(offset + 5),
          width: data.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + segmentLen;
    }
    throw new Error('Could not locate JPEG SOF frame header');
  }

  throw new Error('Unsupported image format: expected PNG or JPEG');
}

function main(): void {
  const sourcePath = join(__dirname, 'entry.png');
  const payload = readFileSync(sourcePath);

  if (payload.length === 0 || payload.length > MAX_BYTES) {
    throw new Error(`Artifact byte size out of bounds: ${payload.length}`);
  }

  const info = validateImageArtifact(payload);
  if (info.width <= 0 || info.height <= 0 || info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) {
    throw new Error(`Artifact dimensions out of bounds: ${info.width}x${info.height}`);
  }

  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  const targetPath = join(outDir, 'entry.png');
  writeFileSync(targetPath, payload);

  const writtenSize = statSync(targetPath).size;
  if (writtenSize !== payload.length) {
    throw new Error(`Output write verification mismatch: ${writtenSize} != ${payload.length}`);
  }
}

main();
