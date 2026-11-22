'use strict';

/**
 * Read the identity of a compiler jar without unpacking it to disk.
 *
 * The build script stamps a MANIFEST so a jar can say which mod commit it came
 * from wherever it is copied; jars built before that change simply report
 * `known: false` and are listed by file name + timestamp instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MANIFEST_NAME = 'META-INF/MANIFEST.MF';

function findEndOfCentralDirectory(buffer) {
  // The comment after EOCD is at most 64 KiB, so search backwards from the end.
  const stop = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= stop; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/** Return the raw bytes of one entry, or undefined when it is absent. */
function readZipEntry(jarPath, wanted) {
  const buffer = fs.readFileSync(jarPath);
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) return undefined;

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return undefined;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (name === wanted) {
      if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) return undefined;
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(start, start + compressedSize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
}

/** Parse `Main`-section attributes of a MANIFEST.MF (continuations included). */
function parseManifest(text) {
  const attributes = new Map();
  let key = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === '') break; // end of the main section
    if (rawLine.startsWith(' ')) {
      if (key !== null) attributes.set(key, attributes.get(key) + rawLine.slice(1));
      continue;
    }
    const colon = rawLine.indexOf(':');
    if (colon < 0) continue;
    key = rawLine.slice(0, colon);
    attributes.set(key, rawLine.slice(colon + 1).trimStart());
  }
  return attributes;
}

/**
 * Describe a jar: `{ path, name, bytes, updatedAt, known, commit, builtAt, release, sources }`.
 * Never throws — an unreadable file comes back with `error` set.
 */
function jarMeta(jarPath) {
  const meta = {
    path: path.resolve(jarPath),
    name: path.basename(jarPath),
    bytes: 0,
    updatedAt: 0,
    known: false,
    commit: '',
    builtAt: '',
    release: '',
    sources: '',
  };
  try {
    const stat = fs.statSync(jarPath);
    meta.bytes = stat.size;
    meta.updatedAt = Math.round(stat.mtimeMs);
  } catch (error) {
    meta.error = String(error?.message ?? error);
    return meta;
  }
  try {
    const raw = readZipEntry(jarPath, MANIFEST_NAME);
    if (raw === undefined) return meta;
    const attributes = parseManifest(raw.toString('utf8'));
    meta.commit = attributes.get('Compiler-Commit') ?? '';
    meta.builtAt = attributes.get('Compiler-Built-At') ?? '';
    meta.release = attributes.get('Compiler-Release') ?? '';
    meta.sources = attributes.get('Compiler-Sources') ?? '';
    meta.known = meta.commit !== '';
  } catch (error) {
    meta.error = String(error?.message ?? error);
  }
  return meta;
}

module.exports = { jarMeta, readZipEntry, parseManifest };
