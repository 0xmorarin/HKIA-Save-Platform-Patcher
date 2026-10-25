const HEADER_SIZE = 32;
const MAX_LZ4_RAW_BLOCK = 32768;
const LZ4_BLOCK_ARRAY_EXT_TYPE = 98;

const LZ4_SECTION_MAGIC = Uint8Array.from([
  0xa1, 0xa2, 0xf8, 0x33, 0x3c, 0x66, 0xec, 0x45,
  0x5b, 0xaa, 0x2d, 0xfc, 0x63, 0x25, 0xc2, 0x43,
  0x7a, 0x77, 0x9c, 0x99, 0x06, 0xee, 0xcf, 0xf0,
  0xc0, 0x22, 0xe5, 0xf6, 0xb6, 0xca, 0x73, 0xb8
]);

export const PLATFORM = Object.freeze({
  WINDOWS_STEAM: 1,
  APPLE_ARCADE: 7,
  SWITCH: 9,
  SWITCH_2: 12,
  PS5: 10
});

export const PLATFORM_LABELS = Object.freeze({
  [PLATFORM.WINDOWS_STEAM]: "Steam",
  4: "Apple Arcade",
  5: "Apple Arcade",
  6: "Apple Arcade",
  [PLATFORM.APPLE_ARCADE]: "Apple Arcade",
  [PLATFORM.SWITCH]: "Nintendo Switch",
  [PLATFORM.SWITCH_2]: "Nintendo Switch",
  [PLATFORM.PS5]: "PlayStation 5"
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

const SUPPORTED_SOURCE_IDS = new Set([1, 4, 5, 6, 7, 9, 10, 12]);
const SUPPORTED_TARGET_IDS = new Set([1, 7, 9, 10]);

function platformGroup(platformType) {
  if ([4, 5, 6, 7].includes(platformType)) return "apple";
  if (platformType === 1) return "steam";
  if (platformType === 9 || platformType === 12) return "switch";
  if (platformType === 10) return "ps5";
  return null;
}

export function patchSavePlatform(input, requestedTarget) {
  const sourceBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const before = parseSave(sourceBytes);
  if (!SUPPORTED_SOURCE_IDS.has(before.platformType)) {
    fail("unsupported_platform", "The source platform is not supported for conversion.");
  }
  if (!SUPPORTED_TARGET_IDS.has(requestedTarget)) {
    fail("unsupported_platform", "The requested destination platform is not supported.");
  }
  if (platformGroup(before.platformType) === platformGroup(requestedTarget)) {
    fail("unsupported_platform", "Conversion within the same platform group is unnecessary.");
  }

  if (!parseLz4Section(sourceBytes, before.platformOffset + before.platformTokenLength)) {
    fail("verification_failed", "This save is missing its required HKIA LZ4 payload section.");
  }

  const output = sourceBytes.slice();
  const token = readInteger(output, before.platformOffset, "verification_failed");
  if (token.next - token.start !== before.platformTokenLength || token.value !== before.platformType) {
    fail("verification_failed", "The platform field changed unexpectedly before patching.");
  }
  writeSmallIntegerInPlace(output, token, requestedTarget);

  const after = parseSave(output);
  if (
    after.applicationVersion !== before.applicationVersion ||
    after.applicationVersionInt !== before.applicationVersionInt ||
    after.timePlayedTicks !== before.timePlayedTicks ||
    after.platformOffset !== before.platformOffset ||
    after.platformTokenLength !== before.platformTokenLength ||
    after.platformType !== requestedTarget ||
    output.length !== sourceBytes.length
  ) {
    fail("verification_failed", "The patched save did not pass metadata verification.");
  }

  for (let i = 0; i < sourceBytes.length; i++) {
    if (i >= token.start && i < token.next) continue;
    if (sourceBytes[i] !== output[i]) {
      fail("verification_failed", "The save changed outside its platform field.");
    }
  }

  return { bytes: output, before, after, targetPlatform: requestedTarget };
}

export function formatPlayTime(ticks) {
  const totalSeconds = Math.floor(ticks / 10000000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}
