const HEADER_SIZE = 32;

export const PLATFORM = Object.freeze({
  WINDOWS_STEAM: 1,
  SWITCH: 9
});

export const PLATFORM_LABELS = Object.freeze({
  [PLATFORM.WINDOWS_STEAM]: "Steam",
  [PLATFORM.SWITCH]: "Nintendo Switch"
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

function ensure(bytes, offset, length) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    fail("not_hkia", "The file structure is incomplete or invalid.");
  }
}

function u16(bytes, offset) {
  ensure(bytes, offset, 2);
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32(bytes, offset) {
  ensure(bytes, offset, 4);
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  ) >>> 0;
}

function readContainerHeader(bytes, offset, kind, errorCode = "not_hkia") {
  ensure(bytes, offset, 1);
  const code = bytes[offset];

  if (kind === "array") {
    if (code >= 0x90 && code <= 0x9F) return { count: code & 0x0F, next: offset + 1 };
    if (code === 0xDC) return { count: u16(bytes, offset + 1), next: offset + 3 };
    if (code === 0xDD) return { count: u32(bytes, offset + 1), next: offset + 5 };
  } else {
    if (code >= 0x80 && code <= 0x8F) return { count: code & 0x0F, next: offset + 1 };
    if (code === 0xDE) return { count: u16(bytes, offset + 1), next: offset + 3 };
    if (code === 0xDF) return { count: u32(bytes, offset + 1), next: offset + 5 };
  }

  fail(errorCode, `Expected a MessagePack ${kind}.`);
}

function readString(bytes, offset) {
  ensure(bytes, offset, 1);
  const code = bytes[offset];
  let length;
  let start;

  if (code >= 0xA0 && code <= 0xBF) {
    length = code & 0x1F;
    start = offset + 1;
  } else if (code === 0xD9) {
    ensure(bytes, offset + 1, 1);
    length = bytes[offset + 1];
    start = offset + 2;
  } else if (code === 0xDA) {
    length = u16(bytes, offset + 1);
    start = offset + 3;
  } else if (code === 0xDB) {
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
  ensure(bytes, offset, 1);
  const code = bytes[offset];

  if (code <= 0x7F) return { value: code, start: offset, next: offset + 1, code };
  if (code >= 0xE0) return { value: code - 0x100, start: offset, next: offset + 1, code };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  switch (code) {
    case 0xCC:
      ensure(bytes, offset + 1, 1);
      return { value: bytes[offset + 1], start: offset, next: offset + 2, code };
    case 0xCD:
      return { value: u16(bytes, offset + 1), start: offset, next: offset + 3, code };
    case 0xCE:
      return { value: u32(bytes, offset + 1), start: offset, next: offset + 5, code };
    case 0xCF: {
      ensure(bytes, offset + 1, 8);
      const value = view.getBigUint64(offset + 1, false);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(errorCode, "A save value is too large to process safely.");
      return { value: Number(value), start: offset, next: offset + 9, code };
    }
    case 0xD0:
      ensure(bytes, offset + 1, 1);
      return { value: view.getInt8(offset + 1), start: offset, next: offset + 2, code };
    case 0xD1:
      ensure(bytes, offset + 1, 2);
      return { value: view.getInt16(offset + 1, false), start: offset, next: offset + 3, code };
    case 0xD2:
      ensure(bytes, offset + 1, 4);
      return { value: view.getInt32(offset + 1, false), start: offset, next: offset + 5, code };
    case 0xD3: {
      ensure(bytes, offset + 1, 8);
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

function skipValue(bytes, offset, depth = 0) {
  if (depth > 256) fail("not_hkia", "The save structure is unexpectedly deep.");
  ensure(bytes, offset, 1);
  const code = bytes[offset];

  if (code <= 0x7F || code >= 0xE0 || code === 0xC0 || code === 0xC2 || code === 0xC3) return offset + 1;

  if (code >= 0xA0 && code <= 0xBF) {
    const length = code & 0x1F;
    ensure(bytes, offset + 1, length);
    return offset + 1 + length;
  }

  if (code >= 0x90 && code <= 0x9F) {
    let cursor = offset + 1;
    const count = code & 0x0F;
    for (let i = 0; i < count; i++) cursor = skipValue(bytes, cursor, depth + 1);
    return cursor;
  }

  if (code >= 0x80 && code <= 0x8F) {
    let cursor = offset + 1;
    const count = code & 0x0F;
    for (let i = 0; i < count * 2; i++) cursor = skipValue(bytes, cursor, depth + 1);
    return cursor;
  }

  switch (code) {
    case 0xC1:
      fail("not_hkia", "The save contains an invalid MessagePack value.");
      break;
    case 0xC4: {
      ensure(bytes, offset + 1, 1);
      const length = bytes[offset + 1];
      ensure(bytes, offset + 2, length);
      return offset + 2 + length;
    }
    case 0xC5: {
      const length = u16(bytes, offset + 1);
      ensure(bytes, offset + 3, length);
      return offset + 3 + length;
    }
    case 0xC6: {
      const length = u32(bytes, offset + 1);
      ensure(bytes, offset + 5, length);
      return offset + 5 + length;
    }
    case 0xC7: {
      ensure(bytes, offset + 1, 2);
      const length = bytes[offset + 1];
      ensure(bytes, offset + 3, length);
      return offset + 3 + length;
    }
    case 0xC8: {
      const length = u16(bytes, offset + 1);
      ensure(bytes, offset + 3, 1 + length);
      return offset + 4 + length;
    }
    case 0xC9: {
      const length = u32(bytes, offset + 1);
      ensure(bytes, offset + 5, 1 + length);
      return offset + 6 + length;
    }
    case 0xCA:
      ensure(bytes, offset, 5);
      return offset + 5;
    case 0xCB:
      ensure(bytes, offset, 9);
      return offset + 9;
    case 0xCC:
    case 0xD0:
      ensure(bytes, offset, 2);
      return offset + 2;
    case 0xCD:
    case 0xD1:
      ensure(bytes, offset, 3);
      return offset + 3;
    case 0xCE:
    case 0xD2:
      ensure(bytes, offset, 5);
      return offset + 5;
    case 0xCF:
    case 0xD3:
      ensure(bytes, offset, 9);
      return offset + 9;
    case 0xD4:
      ensure(bytes, offset, 3);
      return offset + 3;
    case 0xD5:
      ensure(bytes, offset, 4);
      return offset + 4;
    case 0xD6:
      ensure(bytes, offset, 6);
      return offset + 6;
    case 0xD7:
      ensure(bytes, offset, 10);
      return offset + 10;
    case 0xD8:
      ensure(bytes, offset, 18);
      return offset + 18;
    case 0xD9: {
      ensure(bytes, offset + 1, 1);
      const length = bytes[offset + 1];
      ensure(bytes, offset + 2, length);
      return offset + 2 + length;
    }
    case 0xDA: {
      const length = u16(bytes, offset + 1);
      ensure(bytes, offset + 3, length);
      return offset + 3 + length;
    }
    case 0xDB: {
      const length = u32(bytes, offset + 1);
      ensure(bytes, offset + 5, length);
      return offset + 5 + length;
    }
    case 0xDC:
    case 0xDD: {
      const header = readContainerHeader(bytes, offset, "array");
      let cursor = header.next;
      for (let i = 0; i < header.count; i++) cursor = skipValue(bytes, cursor, depth + 1);
      return cursor;
    }
    case 0xDE:
    case 0xDF: {
      const header = readContainerHeader(bytes, offset, "map");
      let cursor = header.next;
      for (let i = 0; i < header.count * 2; i++) cursor = skipValue(bytes, cursor, depth + 1);
      return cursor;
    }
    default:
      fail("not_hkia", "The save contains an unsupported MessagePack value.");
  }
}

function readGuid(bytes, cursor) {
  for (let i = 0; i < 4; i++) {
    const part = readInteger(bytes, cursor);
    if (!Number.isInteger(part.value) || part.value < 0 || part.value > 0xFFFFFFFF) {
      fail("not_hkia", "The save contains an invalid identifier.");
    }
    cursor = part.next;
  }
  return cursor;
}

function writeSmallIntegerInPlace(bytes, token, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0x7F) fail("verification_failed", "The target platform value is invalid.");
  const { start, code } = token;

  if (code <= 0x7F) {
    bytes[start] = value;
    return;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  switch (code) {
    case 0xCC:
      bytes[start + 1] = value;
      return;
    case 0xCD:
      view.setUint16(start + 1, value, false);
      return;
    case 0xCE:
      view.setUint32(start + 1, value, false);
      return;
    case 0xCF:
      view.setBigUint64(start + 1, BigInt(value), false);
      return;
    case 0xD0:
      view.setInt8(start + 1, value);
      return;
    case 0xD1:
      view.setInt16(start + 1, value, false);
      return;
    case 0xD2:
      view.setInt32(start + 1, value, false);
      return;
    case 0xD3:
      view.setBigInt64(start + 1, BigInt(value), false);
      return;
    default:
      fail("verification_failed", "The platform value uses an unsupported integer encoding.");
  }
}

export function parseSave(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (bytes.length < HEADER_SIZE + 1) fail("not_hkia", "This does not appear to be an HKIA save.");

  let cursor = HEADER_SIZE;
  const root = readContainerHeader(bytes, cursor, "array");

  if (root.count < 7) fail("not_hkia", "This does not appear to be an HKIA save.");

  cursor = root.next;
  cursor = readGuid(bytes, cursor);

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

  for (let i = 0; i < ancestors.count; i++) cursor = readGuid(bytes, cursor);

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

  const output = sourceBytes.slice();
  const token = readInteger(output, before.platformOffset, "verification_failed");

  if (token.next - token.start !== before.platformTokenLength || token.value !== before.platformType) {
    fail("verification_failed", "The platform field changed unexpectedly before patching.");
  }

  writeSmallIntegerInPlace(output, token, targetPlatform);

  const after = parseSave(output);

  if (
    after.applicationVersion !== before.applicationVersion ||
    after.applicationVersionInt !== before.applicationVersionInt ||
    after.timePlayedTicks !== before.timePlayedTicks ||
    after.platformOffset !== before.platformOffset ||
    after.platformType !== targetPlatform ||
    output.length !== sourceBytes.length
  ) {
    fail("verification_failed", "The patched save did not pass verification.");
  }

  const changedOffsets = [];

  for (let i = 0; i < sourceBytes.length; i++) {
    if (sourceBytes[i] !== output[i]) changedOffsets.push(i);
  }

  if (changedOffsets.length !== 1 || changedOffsets[0] < token.start || changedOffsets[0] >= token.next) {
    fail("verification_failed", "Unexpected save data changed during patching.");
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
