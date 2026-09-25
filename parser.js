const HEADER_SIZE = 32;
const MAX_LZ4_RAW_BLOCK = 32768;
const DLC_MODEL_UNION_TAG = 30;
const DLC_MODEL_ID = 2;
const LZ4_BLOCK_ARRAY_EXT_TYPE = 98;

const LZ4_SECTION_MAGIC = Uint8Array.from([
  0xa1, 0xa2, 0xf8, 0x33, 0x3c, 0x66, 0xec, 0x45,
  0x5b, 0xaa, 0x2d, 0xfc, 0x63, 0x25, 0xc2, 0x43,
  0x7a, 0x77, 0x9c, 0x99, 0x06, 0xee, 0xcf, 0xf0,
  0xc0, 0x22, 0xe5, 0xf6, 0xb6, 0xca, 0x73, 0xb8
]);

export const PLATFORM = Object.freeze({
  WINDOWS_STEAM: 1,
  SWITCH: 9
});

export const PLATFORM_LABELS = Object.freeze({
  [PLATFORM.WINDOWS_STEAM]: "Steam",
  [PLATFORM.SWITCH]: "Nintendo Switch"
});

const DLC_PLATFORM = Object.freeze({
  [PLATFORM.WINDOWS_STEAM]: 4,
  [PLATFORM.SWITCH]: 3
});

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class SavePatcherError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SavePatcherError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SavePatcherError(code, message);
}

function ensure(bytes, offset, length, code = "not_hkia") {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    fail(code, "The file structure is incomplete or invalid.");
  }
}

function u16(bytes, offset, code = "not_hkia") {
  ensure(bytes, offset, 2, code);
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32(bytes, offset, code = "not_hkia") {
  ensure(bytes, offset, 4, code);
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  ) >>> 0;
}

function readContainerHeader(bytes, offset, kind, errorCode = "not_hkia") {
  ensure(bytes, offset, 1, errorCode);
  const code = bytes[offset];

  if (kind === "array") {
    if (code >= 0x90 && code <= 0x9f) return { count: code & 0x0f, next: offset + 1 };
    if (code === 0xdc) return { count: u16(bytes, offset + 1, errorCode), next: offset + 3 };
    if (code === 0xdd) return { count: u32(bytes, offset + 1, errorCode), next: offset + 5 };
  } else {
    if (code >= 0x80 && code <= 0x8f) return { count: code & 0x0f, next: offset + 1 };
    if (code === 0xde) return { count: u16(bytes, offset + 1, errorCode), next: offset + 3 };
    if (code === 0xdf) return { count: u32(bytes, offset + 1, errorCode), next: offset + 5 };
  }

  fail(errorCode, `Expected a MessagePack ${kind}.`);
}

function readString(bytes, offset) {
  ensure(bytes, offset, 1);
  const code = bytes[offset];
  let length;
  let start;

  if (code >= 0xa0 && code <= 0xbf) {
    length = code & 0x1f;
    start = offset + 1;
  } else if (code === 0xd9) {
    ensure(bytes, offset + 1, 1);
    length = bytes[offset + 1];
    start = offset + 2;
  } else if (code === 0xda) {
    length = u16(bytes, offset + 1);
    start = offset + 3;
  } else if (code === 0xdb) {
    length = u32(bytes, offset + 1);
    start = offset + 5;
  } else {
    fail("not_hkia", "The save does not contain a valid application version.");
  }

  ensure(bytes, start, length);

  try {
    return {
      value: textDecoder.decode(bytes.subarray(start, start + length)),
      next: start + length
    };
  } catch {
    fail("not_hkia", "The application version string is invalid.");
  }
}

function readInteger(bytes, offset, errorCode = "not_hkia") {
  ensure(bytes, offset, 1, errorCode);
  const code = bytes[offset];

  if (code <= 0x7f) return { value: code, start: offset, next: offset + 1, code };
  if (code >= 0xe0) return { value: code - 0x100, start: offset, next: offset + 1, code };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  switch (code) {
    case 0xcc:
      ensure(bytes, offset + 1, 1, errorCode);
      return { value: bytes[offset + 1], start: offset, next: offset + 2, code };
    case 0xcd:
      return { value: u16(bytes, offset + 1, errorCode), start: offset, next: offset + 3, code };
    case 0xce:
      return { value: u32(bytes, offset + 1, errorCode), start: offset, next: offset + 5, code };
    case 0xcf: {
      ensure(bytes, offset + 1, 8, errorCode);
      const value = view.getBigUint64(offset + 1, false);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(errorCode, "A save value is too large to process safely.");
      return { value: Number(value), start: offset, next: offset + 9, code };
    }
    case 0xd0:
      ensure(bytes, offset + 1, 1, errorCode);
      return { value: view.getInt8(offset + 1), start: offset, next: offset + 2, code };
    case 0xd1:
      ensure(bytes, offset + 1, 2, errorCode);
      return { value: view.getInt16(offset + 1, false), start: offset, next: offset + 3, code };
    case 0xd2:
      ensure(bytes, offset + 1, 4, errorCode);
      return { value: view.getInt32(offset + 1, false), start: offset, next: offset + 5, code };
    case 0xd3: {
      ensure(bytes, offset + 1, 8, errorCode);
      const value = view.getBigInt64(offset + 1, false);
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
        fail(errorCode, "A save value is too large to process safely.");
      }
      return { value: Number(value), start: offset, next: offset + 9, code };
    }
    default:
      fail(errorCode, "Expected a MessagePack integer.");
  }
}

function readBoolean(bytes, offset, errorCode = "verification_failed") {
  ensure(bytes, offset, 1, errorCode);
  if (bytes[offset] === 0xc2) return { value: false, next: offset + 1 };
  if (bytes[offset] === 0xc3) return { value: true, next: offset + 1 };
  fail(errorCode, "Expected a MessagePack boolean.");
}

function skipValue(bytes, offset, depth = 0, errorCode = "not_hkia") {
  if (depth > 256) fail(errorCode, "The save structure is unexpectedly deep.");
  ensure(bytes, offset, 1, errorCode);
  const code = bytes[offset];

  if (code <= 0x7f || code >= 0xe0 || code === 0xc0 || code === 0xc2 || code === 0xc3) return offset + 1;

  if (code >= 0xa0 && code <= 0xbf) {
    const length = code & 0x1f;
    ensure(bytes, offset + 1, length, errorCode);
    return offset + 1 + length;
  }

  if (code >= 0x90 && code <= 0x9f) {
    let cursor = offset + 1;
    const count = code & 0x0f;
    for (let i = 0; i < count; i++) cursor = skipValue(bytes, cursor, depth + 1, errorCode);
    return cursor;
  }

  if (code >= 0x80 && code <= 0x8f) {
    let cursor = offset + 1;
    const count = code & 0x0f;
    for (let i = 0; i < count * 2; i++) cursor = skipValue(bytes, cursor, depth + 1, errorCode);
    return cursor;
  }

  switch (code) {
    case 0xc1:
      fail(errorCode, "The save contains an invalid MessagePack value.");
      break;
    case 0xc4: {
      ensure(bytes, offset + 1, 1, errorCode);
      const length = bytes[offset + 1];
      ensure(bytes, offset + 2, length, errorCode);
      return offset + 2 + length;
    }
    case 0xc5: {
      const length = u16(bytes, offset + 1, errorCode);
      ensure(bytes, offset + 3, length, errorCode);
      return offset + 3 + length;
    }
    case 0xc6: {
      const length = u32(bytes, offset + 1, errorCode);
      ensure(bytes, offset + 5, length, errorCode);
      return offset + 5 + length;
    }
    case 0xc7: {
      ensure(bytes, offset + 1, 2, errorCode);
      const length = bytes[offset + 1];
      ensure(bytes, offset + 3, length, errorCode);
      return offset + 3 + length;
    }
    case 0xc8: {
      const length = u16(bytes, offset + 1, errorCode);
      ensure(bytes, offset + 3, 1 + length, errorCode);
      return offset + 4 + length;
    }
    case 0xc9: {
      const length = u32(bytes, offset + 1, errorCode);
      ensure(bytes, offset + 5, 1 + length, errorCode);
      return offset + 6 + length;
    }
    case 0xca:
      ensure(bytes, offset, 5, errorCode);
      return offset + 5;
    case 0xcb:
      ensure(bytes, offset, 9, errorCode);
      return offset + 9;
    case 0xcc:
    case 0xd0:
      ensure(bytes, offset, 2, errorCode);
      return offset + 2;
    case 0xcd:
    case 0xd1:
      ensure(bytes, offset, 3, errorCode);
      return offset + 3;
    case 0xce:
    case 0xd2:
      ensure(bytes, offset, 5, errorCode);
      return offset + 5;
    case 0xcf:
    case 0xd3:
      ensure(bytes, offset, 9, errorCode);
      return offset + 9;
    case 0xd4:
      ensure(bytes, offset, 3, errorCode);
      return offset + 3;
    case 0xd5:
      ensure(bytes, offset, 4, errorCode);
      return offset + 4;
    case 0xd6:
      ensure(bytes, offset, 6, errorCode);
      return offset + 6;
    case 0xd7:
      ensure(bytes, offset, 10, errorCode);
      return offset + 10;
    case 0xd8:
      ensure(bytes, offset, 18, errorCode);
      return offset + 18;
    case 0xd9: {
      ensure(bytes, offset + 1, 1, errorCode);
      const length = bytes[offset + 1];
      ensure(bytes, offset + 2, length, errorCode);
      return offset + 2 + length;
    }
    case 0xda: {
      const length = u16(bytes, offset + 1, errorCode);
      ensure(bytes, offset + 3, length, errorCode);
      return offset + 3 + length;
    }
    case 0xdb: {
      const length = u32(bytes, offset + 1, errorCode);
      ensure(bytes, offset + 5, length, errorCode);
      return offset + 5 + length;
    }
    case 0xdc:
    case 0xdd: {
      const header = readContainerHeader(bytes, offset, "array", errorCode);
      let cursor = header.next;
      for (let i = 0; i < header.count; i++) cursor = skipValue(bytes, cursor, depth + 1, errorCode);
      return cursor;
    }
    case 0xde:
    case 0xdf: {
      const header = readContainerHeader(bytes, offset, "map", errorCode);
      let cursor = header.next;
      for (let i = 0; i < header.count * 2; i++) cursor = skipValue(bytes, cursor, depth + 1, errorCode);
      return cursor;
    }
    default:
      fail(errorCode, "The save contains an unsupported MessagePack value.");
  }
}

function readGuid(bytes, cursor, errorCode = "not_hkia") {
  const values = [];
  for (let i = 0; i < 4; i++) {
    const part = readInteger(bytes, cursor, errorCode);
    if (!Number.isInteger(part.value) || part.value < 0 || part.value > 0xffffffff) {
      fail(errorCode, "The save contains an invalid identifier.");
    }
    values.push(part.value);
    cursor = part.next;
  }
  return { values, next: cursor };
}

function writeSmallIntegerInPlace(bytes, token, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0x7f) fail("verification_failed", "The target platform value is invalid.");
  const { start, code } = token;

  if (code <= 0x7f) {
    bytes[start] = value;
    return;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  switch (code) {
    case 0xcc:
      bytes[start + 1] = value;
      return;
    case 0xcd:
      view.setUint16(start + 1, value, false);
      return;
    case 0xce:
      view.setUint32(start + 1, value, false);
      return;
    case 0xcf:
      view.setBigUint64(start + 1, BigInt(value), false);
      return;
    case 0xd0:
      view.setInt8(start + 1, value);
      return;
    case 0xd1:
      view.setInt16(start + 1, value, false);
      return;
    case 0xd2:
      view.setInt32(start + 1, value, false);
      return;
    case 0xd3:
      view.setBigInt64(start + 1, BigInt(value), false);
      return;
    default:
      fail("verification_failed", "The platform value uses an unsupported integer encoding.");
  }
}

function findSequence(bytes, needle, start) {
  outer: for (let i = start; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function readExtension(bytes, offset, errorCode = "verification_failed") {
  ensure(bytes, offset, 1, errorCode);
  const code = bytes[offset];
  let length;
  let cursor;

  if (code === 0xd4) {
    length = 1;
    cursor = offset + 1;
  } else if (code === 0xd5) {
    length = 2;
    cursor = offset + 1;
  } else if (code === 0xd6) {
    length = 4;
    cursor = offset + 1;
  } else if (code === 0xd7) {
    length = 8;
    cursor = offset + 1;
  } else if (code === 0xd8) {
    length = 16;
    cursor = offset + 1;
  } else if (code === 0xc7) {
    ensure(bytes, offset + 1, 1, errorCode);
    length = bytes[offset + 1];
    cursor = offset + 2;
  } else if (code === 0xc8) {
    length = u16(bytes, offset + 1, errorCode);
    cursor = offset + 3;
  } else if (code === 0xc9) {
    length = u32(bytes, offset + 1, errorCode);
    cursor = offset + 5;
  } else {
    fail(errorCode, "Expected a MessagePack extension.");
  }

  ensure(bytes, cursor, 1 + length, errorCode);
  const type = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt8(cursor);
  const dataStart = cursor + 1;
  return {
    type,
    data: bytes.subarray(dataStart, dataStart + length),
    next: dataStart + length
  };
}

function readBinary(bytes, offset, errorCode = "verification_failed") {
  ensure(bytes, offset, 1, errorCode);
  const code = bytes[offset];
  let length;
  let dataStart;

  if (code === 0xc4) {
    ensure(bytes, offset + 1, 1, errorCode);
    length = bytes[offset + 1];
    dataStart = offset + 2;
  } else if (code === 0xc5) {
    length = u16(bytes, offset + 1, errorCode);
    dataStart = offset + 3;
  } else if (code === 0xc6) {
    length = u32(bytes, offset + 1, errorCode);
    dataStart = offset + 5;
  } else {
    fail(errorCode, "Expected a MessagePack binary block.");
  }

  ensure(bytes, dataStart, length, errorCode);
  return {
    data: bytes.subarray(dataStart, dataStart + length),
    next: dataStart + length
  };
}

function lz4DecompressBlock(source, outputLength) {
  const output = new Uint8Array(outputLength);
  let inputOffset = 0;
  let outputOffset = 0;

  while (inputOffset < source.length) {
    const token = source[inputOffset++];
    let literalLength = token >>> 4;

    if (literalLength === 15) {
      let extension;
      do {
        if (inputOffset >= source.length) fail("verification_failed", "Invalid LZ4 literal length.");
        extension = source[inputOffset++];
        literalLength += extension;
      } while (extension === 255);
    }

    if (inputOffset + literalLength > source.length || outputOffset + literalLength > output.length) {
      fail("verification_failed", "Invalid LZ4 literal data.");
    }

    output.set(source.subarray(inputOffset, inputOffset + literalLength), outputOffset);
    inputOffset += literalLength;
    outputOffset += literalLength;

    if (inputOffset === source.length) break;

    if (inputOffset + 2 > source.length) fail("verification_failed", "Invalid LZ4 match offset.");
    const matchOffset = source[inputOffset] | (source[inputOffset + 1] << 8);
    inputOffset += 2;

    if (matchOffset === 0 || matchOffset > outputOffset) fail("verification_failed", "Invalid LZ4 match distance.");

    let matchLength = token & 0x0f;

    if (matchLength === 15) {
      let extension;
      do {
        if (inputOffset >= source.length) fail("verification_failed", "Invalid LZ4 match length.");
        extension = source[inputOffset++];
        matchLength += extension;
      } while (extension === 255);
    }

    matchLength += 4;

    if (outputOffset + matchLength > output.length) fail("verification_failed", "LZ4 output exceeds the expected block length.");

    const matchStart = outputOffset - matchOffset;
    for (let i = 0; i < matchLength; i++) output[outputOffset + i] = output[matchStart + i];
    outputOffset += matchLength;
  }

  if (inputOffset !== source.length || outputOffset !== output.length) {
    fail("verification_failed", "LZ4 block length verification failed.");
  }

  return output;
}

function pushLength(output, value) {
  while (value >= 255) {
    output.push(255);
    value -= 255;
  }
  output.push(value);
}

function readU32LE(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function lz4CompressBlock(source) {
  const length = source.length;
  const output = [];

  if (length < 13) {
    const literalNibble = Math.min(length, 15);
    output.push(literalNibble << 4);
    if (length >= 15) pushLength(output, length - 15);
    for (let i = 0; i < length; i++) output.push(source[i]);
    return Uint8Array.from(output);
  }

  const table = new Int32Array(65536);
  table.fill(-1);
  const searchLimit = length - 12;
  const matchLimit = length - 5;
  let anchor = 0;
  let cursor = 0;

  while (cursor <= searchLimit) {
    const sequence = readU32LE(source, cursor);
    const hash = (Math.imul(sequence, 0x9e3779b1) >>> 16) & 0xffff;
    const reference = table[hash];
    table[hash] = cursor;

    if (
      reference >= 0 &&
      cursor - reference <= 0xffff &&
      source[reference] === source[cursor] &&
      source[reference + 1] === source[cursor + 1] &&
      source[reference + 2] === source[cursor + 2] &&
      source[reference + 3] === source[cursor + 3]
    ) {
      let matchEnd = cursor + 4;
      let referenceEnd = reference + 4;

      while (matchEnd < matchLimit && source[matchEnd] === source[referenceEnd]) {
        matchEnd += 1;
        referenceEnd += 1;
      }

      const literalLength = cursor - anchor;
      const matchLength = matchEnd - cursor;
      const matchCode = matchLength - 4;
      const tokenIndex = output.length;
      output.push(0);
      output[tokenIndex] = (Math.min(literalLength, 15) << 4) | Math.min(matchCode, 15);

      if (literalLength >= 15) pushLength(output, literalLength - 15);
      for (let i = anchor; i < cursor; i++) output.push(source[i]);

      const distance = cursor - reference;
      output.push(distance & 0xff, distance >>> 8);

      if (matchCode >= 15) pushLength(output, matchCode - 15);

      const previousCursor = cursor;
      cursor = matchEnd;
      anchor = cursor;

      for (let i = previousCursor + 1; i < cursor && i <= searchLimit; i++) {
        const innerSequence = readU32LE(source, i);
        const innerHash = (Math.imul(innerSequence, 0x9e3779b1) >>> 16) & 0xffff;
        table[innerHash] = i;
      }

      continue;
    }

    cursor += 1;
  }

  const literalLength = length - anchor;
  output.push(Math.min(literalLength, 15) << 4);
  if (literalLength >= 15) pushLength(output, literalLength - 15);
  for (let i = anchor; i < length; i++) output.push(source[i]);
  return Uint8Array.from(output);
}

function parseLengthStream(bytes) {
  const lengths = [];
  let cursor = 0;

  while (cursor < bytes.length) {
    const token = readInteger(bytes, cursor, "verification_failed");
    if (!Number.isInteger(token.value) || token.value < 1 || token.value > MAX_LZ4_RAW_BLOCK) {
      fail("verification_failed", "Invalid LZ4 block length.");
    }
    lengths.push(token.value);
    cursor = token.next;
  }

  if (lengths.length === 0) fail("verification_failed", "The LZ4 block list is empty.");
  return lengths;
}

function parseLz4Section(bytes, searchStart) {
  const magicOffset = findSequence(bytes, LZ4_SECTION_MAGIC, searchStart);
  if (magicOffset < 0) return null;

  if (findSequence(bytes, LZ4_SECTION_MAGIC, magicOffset + 1) >= 0) {
    fail("verification_failed", "The save contains more than one LZ4 data section marker.");
  }

  const wrapperOffset = magicOffset + LZ4_SECTION_MAGIC.length;
  const wrapper = readContainerHeader(bytes, wrapperOffset, "array", "verification_failed");
  if (wrapper.count < 2) fail("verification_failed", "The LZ4 data section is incomplete.");

  let cursor = wrapper.next;
  const extension = readExtension(bytes, cursor);
  cursor = extension.next;

  if (extension.type !== LZ4_BLOCK_ARRAY_EXT_TYPE) fail("verification_failed", "The LZ4 block metadata type is not supported.");

  const rawLengths = parseLengthStream(extension.data);
  if (rawLengths.length !== wrapper.count - 1) fail("verification_failed", "The LZ4 block count does not match its metadata.");

  const blocks = [];
  const payloadParts = [];
  let payloadLength = 0;

  for (let i = 0; i < rawLengths.length; i++) {
    const binary = readBinary(bytes, cursor);
    cursor = binary.next;
    const raw = lz4DecompressBlock(binary.data, rawLengths[i]);
    blocks.push(binary.data);
    payloadParts.push(raw);
    payloadLength += raw.length;
  }

  if (cursor !== bytes.length) fail("verification_failed", "Unexpected data follows the HKIA save payload.");

  const payload = new Uint8Array(payloadLength);
  let outputOffset = 0;

  for (const part of payloadParts) {
    payload.set(part, outputOffset);
    outputOffset += part.length;
  }

  return {
    magicOffset,
    wrapperOffset,
    wrapperEnd: cursor,
    rawLengths,
    blocks,
    payload
  };
}

function parseDbRoot(payload) {
  let cursor = 0;
  const root = readContainerHeader(payload, cursor, "array", "verification_failed");
  if (root.count !== 3) fail("verification_failed", "The HKIA database root uses an unsupported structure.");
  cursor = root.next;

  const version = readInteger(payload, cursor, "verification_failed");
  cursor = version.next;
  const nextId = readInteger(payload, cursor, "verification_failed");
  cursor = nextId.next;

  const documents = readContainerHeader(payload, cursor, "array", "verification_failed");
  return {
    version: version.value,
    nextId: nextId.value,
    documentCount: documents.count,
    documentsStart: documents.next
  };
}

function parseIntList(payload, offset, maximumCount = 128) {
  const start = offset;
  const header = readContainerHeader(payload, offset, "array", "verification_failed");
  if (header.count > maximumCount) fail("verification_failed", "A DLC platform list is unexpectedly large.");
  const values = [];
  let cursor = header.next;

  for (let i = 0; i < header.count; i++) {
    const token = readInteger(payload, cursor, "verification_failed");
    if (!Number.isInteger(token.value)) fail("verification_failed", "A DLC platform value is invalid.");
    values.push(token.value);
    cursor = token.next;
  }

  return { start, end: cursor, values };
}

function parseGuidList(payload, offset, maximumCount = 128) {
  const header = readContainerHeader(payload, offset, "array", "verification_failed");
  if (header.count > maximumCount) fail("verification_failed", "A DLC identifier list is unexpectedly large.");
  const values = [];
  let cursor = header.next;

  for (let i = 0; i < header.count; i++) {
    const guid = readGuid(payload, cursor, "verification_failed");
    values.push(guid.values);
    cursor = guid.next;
  }

  return { values, next: cursor };
}

function parseBundleState(payload, offset) {
  const start = offset;
  const header = readContainerHeader(payload, offset, "array", "verification_failed");
  if (header.count !== 3) fail("verification_failed", "A DLC bundle uses an unsupported structure.");
  let cursor = header.next;
  const guid = readGuid(payload, cursor, "verification_failed");
  cursor = guid.next;
  const owned = readBoolean(payload, cursor);
  cursor = owned.next;
  const platforms = parseIntList(payload, cursor);
  cursor = platforms.end;

  return {
    start,
    end: cursor,
    guid: guid.values,
    isOwned: owned.value,
    platforms
  };
}

function parseContentState(payload, offset) {
  const start = offset;
  const header = readContainerHeader(payload, offset, "array", "verification_failed");
  if (header.count !== 3) fail("verification_failed", "A DLC content state uses an unsupported structure.");
  let cursor = header.next;
  const guid = readGuid(payload, cursor, "verification_failed");
  cursor = guid.next;
  const owned = readBoolean(payload, cursor);
  cursor = owned.next;
  const bundles = parseGuidList(payload, cursor);
  cursor = bundles.next;

  return {
    start,
    end: cursor,
    guid: guid.values,
    isOwned: owned.value,
    ownedFromBundles: bundles.values
  };
}

function parseDlcModelAt(payload, offset) {
  const start = offset;
  const union = readContainerHeader(payload, offset, "array", "verification_failed");
  if (union.count !== 2) fail("verification_failed", "The DLC model union uses an unsupported structure.");
  let cursor = union.next;
  const tag = readInteger(payload, cursor, "verification_failed");
  cursor = tag.next;
  if (tag.value !== DLC_MODEL_UNION_TAG) fail("verification_failed", "The DLC model tag is invalid.");

  const body = readContainerHeader(payload, cursor, "array", "verification_failed");
  if (body.count !== 4) fail("verification_failed", "The DLC model uses an unsupported structure.");
  cursor = body.next;

  const modelId = readInteger(payload, cursor, "verification_failed");
  cursor = modelId.next;
  if (modelId.value !== DLC_MODEL_ID) fail("verification_failed", "The DLC model identifier is not supported.");

  const bundleHeader = readContainerHeader(payload, cursor, "array", "verification_failed");
  if (bundleHeader.count > 256) fail("verification_failed", "The DLC bundle count is unexpectedly large.");
  cursor = bundleHeader.next;
  const bundles = [];

  for (let i = 0; i < bundleHeader.count; i++) {
    const bundle = parseBundleState(payload, cursor);
    bundles.push(bundle);
    cursor = bundle.end;
  }

  const contentHeader = readContainerHeader(payload, cursor, "array", "verification_failed");
  if (contentHeader.count > 256) fail("verification_failed", "The DLC content count is unexpectedly large.");
  cursor = contentHeader.next;
  const contents = [];

  for (let i = 0; i < contentHeader.count; i++) {
    const content = parseContentState(payload, cursor);
    contents.push(content);
    cursor = content.end;
  }

  const seenPlatforms = parseIntList(payload, cursor);
  cursor = seenPlatforms.end;

  return {
    start,
    end: cursor,
    tag: tag.value,
    modelId: modelId.value,
    bundles,
    contents,
    seenPlatforms
  };
}

function findAllSequences(bytes, needle, start) {
  const offsets = [];
  let cursor = start;

  while (cursor <= bytes.length - needle.length) {
    const found = findSequence(bytes, needle, cursor);
    if (found < 0) break;
    offsets.push(found);
    cursor = found + 1;
  }

  return offsets;
}

function findDlcModel(payload, dbRoot) {
  const prefix = Uint8Array.of(0x92, 0xd2, 0x00, 0x00, 0x00, DLC_MODEL_UNION_TAG);
  const locations = findAllSequences(payload, prefix, dbRoot.documentsStart);
  const candidates = [];

  for (const location of locations) {
    try {
      candidates.push(parseDlcModelAt(payload, location));
    } catch {
      fail("verification_failed", "A DLC model tag was found with an unsupported structure.");
    }
  }

  if (candidates.length > 1) fail("verification_failed", "More than one DLC model was found in the save.");
  return candidates[0] ?? null;
}

function packArrayHeader(count) {
  if (!Number.isInteger(count) || count < 0) fail("verification_failed", "Invalid array length.");
  if (count <= 15) return Uint8Array.of(0x90 | count);
  if (count <= 0xffff) return Uint8Array.of(0xdc, count >>> 8, count & 0xff);
  if (count <= 0xffffffff) {
    return Uint8Array.of(0xdd, (count >>> 24) & 0xff, (count >>> 16) & 0xff, (count >>> 8) & 0xff, count & 0xff);
  }
  fail("verification_failed", "Array length is too large.");
}

function packUnsigned(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("verification_failed", "Invalid unsigned value.");
  if (value <= 0x7f) return Uint8Array.of(value);
  if (value <= 0xff) return Uint8Array.of(0xcc, value);
  if (value <= 0xffff) return Uint8Array.of(0xcd, value >>> 8, value & 0xff);
  if (value <= 0xffffffff) {
    return Uint8Array.of(0xce, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }
  const output = new Uint8Array(9);
  output[0] = 0xcf;
  new DataView(output.buffer).setBigUint64(1, BigInt(value), false);
  return output;
}

function concatBytes(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function packPlatformList(values) {
  return concatBytes([packArrayHeader(values.length), ...values.map(packUnsigned)]);
}

function replaceRanges(bytes, replacements) {
  const ordered = [...replacements].sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;

  for (const replacement of ordered) {
    if (replacement.start < cursor || replacement.start < 0 || replacement.end < replacement.start || replacement.end > bytes.length) {
      fail("verification_failed", "Overlapping or invalid save patch ranges were generated.");
    }
    parts.push(bytes.subarray(cursor, replacement.start));
    parts.push(replacement.data);
    cursor = replacement.end;
  }

  parts.push(bytes.subarray(cursor));
  return concatBytes(parts);
}

function targetBundlePlatforms(bundle, targetDlcPlatform) {
  if (bundle.isOwned || bundle.platforms.values.length > 0) return [targetDlcPlatform];
  return [];
}

function patchDlcPayload(payload, model, targetDlcPlatform) {
  if (!model) return payload;
  const replacements = [];

  for (const bundle of model.bundles) {
    replacements.push({
      start: bundle.platforms.start,
      end: bundle.platforms.end,
      data: packPlatformList(targetBundlePlatforms(bundle, targetDlcPlatform))
    });
  }

  replacements.push({
    start: model.seenPlatforms.start,
    end: model.seenPlatforms.end,
    data: packPlatformList([targetDlcPlatform])
  });

  return replaceRanges(payload, replacements);
}

function splitPayload(payload, originalLengths) {
  const chunks = [];
  let offset = 0;

  for (const originalLength of originalLengths) {
    if (offset >= payload.length) break;
    const length = Math.min(originalLength, payload.length - offset);
    if (length > 0) {
      chunks.push(payload.subarray(offset, offset + length));
      offset += length;
    }
  }

  while (offset < payload.length) {
    const length = Math.min(MAX_LZ4_RAW_BLOCK, payload.length - offset);
    chunks.push(payload.subarray(offset, offset + length));
    offset += length;
  }

  if (chunks.length === 0) fail("verification_failed", "The HKIA save payload is empty.");
  return chunks;
}

function packExtension(type, data) {
  const typeByte = type & 0xff;
  if (data.length <= 0xff) return concatBytes([Uint8Array.of(0xc7, data.length, typeByte), data]);
  if (data.length <= 0xffff) {
    return concatBytes([Uint8Array.of(0xc8, data.length >>> 8, data.length & 0xff, typeByte), data]);
  }
  return concatBytes([
    Uint8Array.of(0xc9, (data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff, typeByte),
    data
  ]);
}

function packBin32(data) {
  const length = data.length;
  return concatBytes([
    Uint8Array.of(0xc6, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff),
    data
  ]);
}

function buildLz4Wrapper(payload, originalLengths) {
  const chunks = splitPayload(payload, originalLengths);
  const lengths = chunks.map((chunk) => chunk.length);
  const lengthPayload = concatBytes(lengths.map(packUnsigned));
  const compressed = chunks.map(lz4CompressBlock);
  return concatBytes([
    packArrayHeader(compressed.length + 1),
    packExtension(LZ4_BLOCK_ARRAY_EXT_TYPE, lengthPayload),
    ...compressed.map(packBin32)
  ]);
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function equalNumberArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function equalGuid(a, b) {
  return equalNumberArray(a, b);
}

function equalGuidList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!equalGuid(a[i], b[i])) return false;
  return true;
}

function verifyDlcSemanticChange(beforeModel, afterModel, targetDlcPlatform) {
  if (!beforeModel && !afterModel) return;
  if (!beforeModel || !afterModel) fail("verification_failed", "The DLC model appeared or disappeared during patching.");

  if (
    beforeModel.tag !== afterModel.tag ||
    beforeModel.modelId !== afterModel.modelId ||
    beforeModel.bundles.length !== afterModel.bundles.length ||
    beforeModel.contents.length !== afterModel.contents.length
  ) {
    fail("verification_failed", "The DLC model structure changed unexpectedly.");
  }

  if (!equalNumberArray(afterModel.seenPlatforms.values, [targetDlcPlatform])) {
    fail("verification_failed", "The DLC platform state was not normalized correctly.");
  }

  for (let i = 0; i < beforeModel.bundles.length; i++) {
    const before = beforeModel.bundles[i];
    const after = afterModel.bundles[i];
    const expectedPlatforms = targetBundlePlatforms(before, targetDlcPlatform);

    if (!equalGuid(before.guid, after.guid) || before.isOwned !== after.isOwned || !equalNumberArray(after.platforms.values, expectedPlatforms)) {
      fail("verification_failed", "A DLC bundle changed outside the allowed platform fields.");
    }
  }

  for (let i = 0; i < beforeModel.contents.length; i++) {
    const before = beforeModel.contents[i];
    const after = afterModel.contents[i];

    if (
      !equalGuid(before.guid, after.guid) ||
      before.isOwned !== after.isOwned ||
      !equalGuidList(before.ownedFromBundles, after.ownedFromBundles)
    ) {
      fail("verification_failed", "A DLC content state changed unexpectedly.");
    }
  }
}

function comparePrefixExceptPlatform(source, output, end, platformStart, platformEnd) {
  if (end > source.length || end > output.length) fail("verification_failed", "The save prefix length changed unexpectedly.");
  for (let i = 0; i < end; i++) {
    if (i >= platformStart && i < platformEnd) continue;
    if (source[i] !== output[i]) fail("verification_failed", "Unexpected save metadata changed during patching.");
  }
}

export function parseSave(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (bytes.length < HEADER_SIZE + 1) fail("not_hkia", "This does not appear to be an HKIA save.");

  let cursor = HEADER_SIZE;
  const root = readContainerHeader(bytes, cursor, "array");

  if (root.count < 7) fail("not_hkia", "This does not appear to be an HKIA save.");

  cursor = root.next;
  const saveGuid = readGuid(bytes, cursor);
  cursor = saveGuid.next;

  const applicationVersion = readString(bytes, cursor);
  cursor = applicationVersion.next;

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(applicationVersion.value)) {
    fail("not_hkia", "This does not appear to be an HKIA save.");
  }

  const versionInt = readInteger(bytes, cursor);
  cursor = versionInt.next;

  if (!Number.isInteger(versionInt.value) || versionInt.value < 0) {
    fail("not_hkia", "This does not appear to be an HKIA save.");
  }

  cursor = skipValue(bytes, cursor);

  const timePlayed = readInteger(bytes, cursor);
  cursor = timePlayed.next;

  if (!Number.isFinite(timePlayed.value) || timePlayed.value < 0) {
    fail("not_hkia", "This does not appear to be an HKIA save.");
  }

  readContainerHeader(bytes, cursor, "map");
  cursor = skipValue(bytes, cursor);

  const ancestors = readContainerHeader(bytes, cursor, "array");
  cursor = ancestors.next;

  if (ancestors.count > 100000) fail("not_hkia", "This does not appear to be an HKIA save.");

  for (let i = 0; i < ancestors.count; i++) {
    const ancestor = readGuid(bytes, cursor);
    cursor = ancestor.next;
  }

  if (root.count < 8) fail("platform_missing", "This HKIA save does not contain platform information.");

  let platformObject;

  try {
    platformObject = readContainerHeader(bytes, cursor, "array", "platform_missing");
  } catch (error) {
    if (error instanceof SavePatcherError && error.code === "platform_missing") throw error;
    fail("platform_missing", "This HKIA save does not contain platform information.");
  }

  if (platformObject.count < 1) fail("platform_missing", "This HKIA save does not contain platform information.");

  cursor = platformObject.next;
  const platformToken = readInteger(bytes, cursor, "platform_missing");

  return {
    applicationVersion: applicationVersion.value,
    applicationVersionInt: versionInt.value,
    timePlayedTicks: timePlayed.value,
    platformType: platformToken.value,
    platformOffset: platformToken.start,
    platformTokenLength: platformToken.next - platformToken.start,
    fileSize: bytes.length
  };
}

export function targetPlatformFor(platformType) {
  if (platformType === PLATFORM.WINDOWS_STEAM) return PLATFORM.SWITCH;
  if (platformType === PLATFORM.SWITCH) return PLATFORM.WINDOWS_STEAM;
  return null;
}

export function patchSavePlatform(input) {
  const sourceBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const before = parseSave(sourceBytes);
  const targetPlatform = targetPlatformFor(before.platformType);

  if (targetPlatform == null) fail("unsupported_platform", "This HKIA save uses an unsupported platform.");

  const targetDlcPlatform = DLC_PLATFORM[targetPlatform];
  const lz4Before = parseLz4Section(sourceBytes, before.platformOffset + before.platformTokenLength);
  const prefix = sourceBytes.slice(0, lz4Before ? lz4Before.wrapperOffset : sourceBytes.length);
  const token = readInteger(prefix, before.platformOffset, "verification_failed");

  if (token.next - token.start !== before.platformTokenLength || token.value !== before.platformType) {
    fail("verification_failed", "The platform field changed unexpectedly before patching.");
  }

  writeSmallIntegerInPlace(prefix, token, targetPlatform);

  let output;
  let beforeModel = null;
  let expectedPayload = null;

  if (lz4Before) {
    const dbBefore = parseDbRoot(lz4Before.payload);
    beforeModel = findDlcModel(lz4Before.payload, dbBefore);
    expectedPayload = patchDlcPayload(lz4Before.payload, beforeModel, targetDlcPlatform);
    const wrapper = beforeModel ? buildLz4Wrapper(expectedPayload, lz4Before.rawLengths) : sourceBytes.subarray(lz4Before.wrapperOffset);
    output = beforeModel ? concatBytes([prefix, wrapper]) : concatBytes([prefix, sourceBytes.subarray(lz4Before.wrapperOffset)]);
  } else {
    output = prefix;
  }

  const after = parseSave(output);

  if (
    after.applicationVersion !== before.applicationVersion ||
    after.applicationVersionInt !== before.applicationVersionInt ||
    after.timePlayedTicks !== before.timePlayedTicks ||
    after.platformOffset !== before.platformOffset ||
    after.platformType !== targetPlatform
  ) {
    fail("verification_failed", "The patched save did not pass metadata verification.");
  }

  if (lz4Before) {
    const lz4After = parseLz4Section(output, after.platformOffset + after.platformTokenLength);
    if (!lz4After) fail("verification_failed", "The patched save lost its HKIA payload section.");

    comparePrefixExceptPlatform(sourceBytes, output, lz4Before.wrapperOffset, before.platformOffset, before.platformOffset + before.platformTokenLength);

    if (beforeModel) {
      if (!equalBytes(lz4After.payload, expectedPayload)) fail("verification_failed", "The decompressed patched payload does not match the intended data.");
      const dbAfter = parseDbRoot(lz4After.payload);
      const afterModel = findDlcModel(lz4After.payload, dbAfter);
      verifyDlcSemanticChange(beforeModel, afterModel, targetDlcPlatform);
    } else {
      if (!equalBytes(sourceBytes.subarray(lz4Before.wrapperOffset), output.subarray(lz4After.wrapperOffset))) {
        fail("verification_failed", "The save payload changed even though no DLC model was present.");
      }
    }
  } else {
    comparePrefixExceptPlatform(sourceBytes, output, sourceBytes.length, before.platformOffset, before.platformOffset + before.platformTokenLength);
  }

  return { bytes: output, before, after, targetPlatform };
}

export function formatPlayTime(ticks) {
  const totalSeconds = Math.floor(ticks / 10000000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}
