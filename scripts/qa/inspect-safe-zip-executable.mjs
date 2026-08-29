import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const endOfCentralDirectorySignature = 0x06054b50;
const centralDirectorySignature = 0x02014b50;
const localHeaderSignature = 0x04034b50;
const maximumArchiveBytes = 512 * 1024 * 1024;
const maximumExecutableBytes = 256 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(message) {
  throw new Error(`Unsafe Windows desktop ZIP: ${message}`);
}

function decodeName(bytes) {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    invalid("entry name is not valid UTF-8");
  }
}

function assertSafeMember(name) {
  if (!name || name.includes("\\") || name.includes("\0") ||
      name.startsWith("/") || /^[A-Za-z]:/u.test(name)) {
    invalid(`entry path is unsafe: ${JSON.stringify(name)}`);
  }
  const withoutTrailingSlash = name.endsWith("/") ? name.slice(0, -1) : name;
  const segments = withoutTrailingSlash.split("/");
  if (!withoutTrailingSlash || segments.some(
    (segment) => !segment || segment === "." || segment === ".."
  )) {
    invalid(`entry path is unsafe: ${JSON.stringify(name)}`);
  }
}

function findEndOfCentralDirectory(archive) {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === endOfCentralDirectorySignature) {
      const commentLength = archive.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === archive.length) return offset;
    }
  }
  invalid("end-of-central-directory record is missing");
}

function parseCentralDirectory(archive) {
  const endOffset = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount ||
      entryCount === 0xffff || centralSize === 0xffffffff ||
      centralOffset === 0xffffffff || centralOffset + centralSize !== endOffset) {
    invalid("multi-disk, ZIP64, or malformed central directory is unsupported");
  }
  const entries = [];
  const names = new Set();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset ||
        archive.readUInt32LE(offset) !== centralDirectorySignature) {
      invalid("central directory entry is truncated or malformed");
    }
    const versionMadeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const compression = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > endOffset || compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff || localOffset === 0xffffffff ||
        (flags & 1) !== 0) {
      invalid("encrypted, ZIP64, or truncated entry is unsupported");
    }
    const name = decodeName(archive.subarray(offset + 46, offset + 46 + nameLength));
    assertSafeMember(name);
    if (names.has(name)) invalid(`duplicate entry: ${name}`);
    names.add(name);
    const creatorSystem = versionMadeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    if (creatorSystem === 3 && (unixMode & 0o170000) === 0o120000) {
      invalid(`symbolic-link entry is forbidden: ${name}`);
    }
    entries.push({
      name,
      flags,
      compression,
      compressedSize,
      uncompressedSize,
      localOffset
    });
    offset = entryEnd;
  }
  if (offset !== endOffset) invalid("central directory size does not match entries");
  return { centralOffset, entries };
}

function entryBytes(archive, centralOffset, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > centralOffset || archive.readUInt32LE(offset) !== localHeaderSignature) {
    invalid(`local header is missing for ${entry.name}`);
  }
  const flags = archive.readUInt16LE(offset + 6);
  const compression = archive.readUInt16LE(offset + 8);
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const localName = decodeName(archive.subarray(offset + 30, offset + 30 + nameLength));
  if (localName !== entry.name || flags !== entry.flags ||
      compression !== entry.compression ||
      dataOffset + entry.compressedSize > centralOffset) {
    invalid(`local header disagrees with central directory for ${entry.name}`);
  }
  if (entry.uncompressedSize < 1 ||
      entry.uncompressedSize > maximumExecutableBytes) {
    invalid("managed executable size is invalid");
  }
  const compressed = archive.subarray(dataOffset, dataOffset + entry.compressedSize);
  let result;
  if (entry.compression === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      invalid("stored executable size is inconsistent");
    }
    result = compressed;
  } else if (entry.compression === 8) {
    try {
      result = inflateRawSync(compressed, {
        maxOutputLength: entry.uncompressedSize
      });
    } catch {
      invalid("managed executable deflate stream is invalid");
    }
  } else {
    invalid(`managed executable uses unsupported compression ${entry.compression}`);
  }
  if (result.length !== entry.uncompressedSize) {
    invalid("managed executable size does not match the central directory");
  }
  return result;
}

export async function inspectSafeZipExecutable(filename, expectedMember) {
  assertSafeMember(expectedMember);
  const details = await lstat(filename);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 22 ||
      details.size > maximumArchiveBytes) {
    invalid("archive must be one bounded non-empty regular file");
  }
  const archive = await readFile(filename);
  const { centralOffset, entries } = parseCentralDirectory(archive);
  const matches = entries.filter((entry) => entry.name === expectedMember);
  if (matches.length !== 1 || expectedMember.endsWith("/")) {
    invalid(`expected exactly one ${expectedMember}`);
  }
  const executable = entryBytes(archive, centralOffset, matches[0]);
  return {
    executableSha256: createHash("sha256").update(executable).digest("hex"),
    executableSize: executable.length
  };
}
