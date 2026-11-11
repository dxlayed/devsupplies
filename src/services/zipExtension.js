const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 table for standard ZIP format
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
  crcTable[i] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

/**
 * Creates a standard unencrypted ZIP buffer from an array of files.
 * files: Array<{ name: string, data: Buffer }>
 */
function createZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const dataBuf = f.data;
    const crc = crc32(dataBuf);
    const compressed = zlib.deflateRawSync(dataBuf);
    const useDeflate = compressed.length < dataBuf.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? compressed : dataBuf;

    // Local Header (30 bytes)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // Local file header signature
    lh.writeUInt16LE(20, 4);         // Version needed to extract (2.0)
    lh.writeUInt16LE(0, 6);          // General purpose bit flag
    lh.writeUInt16LE(method, 8);     // Compression method
    lh.writeUInt16LE(0, 10);         // Last mod file time
    lh.writeUInt16LE(0, 12);         // Last mod file date
    lh.writeUInt32LE(crc, 14);       // CRC-32
    lh.writeUInt32LE(body.length, 18); // Compressed size
    lh.writeUInt32LE(dataBuf.length, 22); // Uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26); // File name length
    lh.writeUInt16LE(0, 28);         // Extra field length

    localHeaders.push(lh, nameBuf, body);

    // Central Directory Header (46 bytes)
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // Central directory signature
    ch.writeUInt16LE(20, 4);         // Version made by
    ch.writeUInt16LE(20, 6);         // Version needed to extract
    ch.writeUInt16LE(0, 8);          // General purpose bit flag
    ch.writeUInt16LE(method, 10);    // Compression method
    ch.writeUInt16LE(0, 12);         // Last mod file time
    ch.writeUInt16LE(0, 14);         // Last mod file date
    ch.writeUInt32LE(crc, 16);       // CRC-32
    ch.writeUInt32LE(body.length, 20); // Compressed size
    ch.writeUInt32LE(dataBuf.length, 24); // Uncompressed size
    ch.writeUInt16LE(nameBuf.length, 28); // File name length
    ch.writeUInt16LE(0, 30);         // Extra field length
    ch.writeUInt16LE(0, 32);         // File comment length
    ch.writeUInt16LE(0, 34);         // Disk number start
    ch.writeUInt16LE(0, 36);         // Internal file attributes
    ch.writeUInt32LE(0, 38);         // External file attributes
    ch.writeUInt32LE(offset, 42);    // Relative offset of local header

    centralHeaders.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central dir signature
  eocd.writeUInt16LE(0, 4);          // Number of this disk
  eocd.writeUInt16LE(0, 6);          // Disk with start of central directory
  eocd.writeUInt16LE(files.length, 8); // Entries on this disk
  eocd.writeUInt16LE(files.length, 10); // Total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // Size of central directory
  eocd.writeUInt32LE(offset, 16);    // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);         // Comment length

  return Buffer.concat([...localHeaders, centralBuf, eocd]);
}

/**
 * Builds the ZIP buffer for the Waurks extension.
 * Reads all files from the `extension/` directory.
 */
function getExtensionZipBuffer() {
  const extDir = path.join(__dirname, '..', '..', 'extension');
  const fileNames = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js'];
  const files = [];

  for (const fn of fileNames) {
    const fullPath = path.join(extDir, fn);
    if (fs.existsSync(fullPath)) {
      files.push({
        name: 'waurks-extension/' + fn,
        data: fs.readFileSync(fullPath)
      });
    }
  }

  return createZip(files);
}

/**
 * Ensures public/waurks-extension.zip exists and is up to date.
 */
function ensureExtensionZip() {
  try {
    const zipBuf = getExtensionZipBuffer();
    const publicPath = path.join(__dirname, '..', '..', 'public', 'waurks-extension.zip');
    fs.writeFileSync(publicPath, zipBuf);
    return true;
  } catch (err) {
    console.error('[zip] Failed to write extension zip:', err.message);
    return false;
  }
}

module.exports = {
  createZip,
  getExtensionZipBuffer,
  ensureExtensionZip
};

