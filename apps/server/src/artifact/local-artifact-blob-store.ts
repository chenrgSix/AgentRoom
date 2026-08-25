import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync
} from "node:fs";
import path from "node:path";

const noFollow = "O_NOFOLLOW" in constants
  ? constants.O_NOFOLLOW
  : 0;

export class LocalArtifactBlobStore {
  private readonly root: string;

  public constructor(root: string) {
    this.root = path.resolve(root);
    mkdirSync(path.join(this.root, "tmp"), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(this.root, "sealed"), { recursive: true, mode: 0o700 });
  }

  public ensureUpload(storageKey: string): void {
    const target = this.resolve(storageKey);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      const descriptor = openSync(
        target,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600
      );
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      this.syncDirectory(path.dirname(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      this.requireRegular(target);
    }
  }

  public size(storageKey: string): number {
    return this.requireRegular(this.resolve(storageKey)).size;
  }

  public existsRegular(storageKey: string): boolean {
    const target = this.resolve(storageKey);
    if (!existsSync(target)) return false;
    this.requireRegular(target);
    return true;
  }

  public hasMatchingBlob(
    storageKey: string,
    expectedSha256: string,
    expectedSize: number
  ): boolean {
    if (!this.existsRegular(storageKey)) return false;
    this.assertDigest(storageKey, expectedSha256, expectedSize);
    return true;
  }

  public truncate(storageKey: string, size: number): void {
    const target = this.resolve(storageKey);
    this.requireRegular(target);
    const descriptor = openSync(target, constants.O_RDWR | noFollow);
    try {
      ftruncateSync(descriptor, size);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  public append(storageKey: string, offset: number, source: Buffer): void {
    const target = this.resolve(storageKey);
    this.requireRegular(target);
    const descriptor = openSync(target, constants.O_RDWR | noFollow);
    try {
      let written = 0;
      while (written < source.length) {
        written += writeSync(
          descriptor,
          source,
          written,
          source.length - written,
          offset + written
        );
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  public matches(
    storageKey: string,
    offset: number,
    source: Buffer
  ): boolean {
    const target = this.resolve(storageKey);
    this.requireRegular(target);
    const descriptor = openSync(target, constants.O_RDONLY | noFollow);
    try {
      const existing = Buffer.alloc(source.length);
      const count = readSync(descriptor, existing, 0, existing.length, offset);
      return count === source.length && timingSafeEqual(existing, source);
    } finally {
      closeSync(descriptor);
    }
  }

  public digest(storageKey: string): { sha256: string; size: number } {
    const target = this.resolve(storageKey);
    this.requireRegular(target);
    const descriptor = openSync(target, constants.O_RDONLY | noFollow);
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile()) {
        throw new Error("Artifact Blob storage entry is not a regular file");
      }
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 << 10);
      let offset = 0;
      while (offset < info.size) {
        const count = readSync(
          descriptor,
          buffer,
          0,
          Math.min(buffer.length, info.size - offset),
          offset
        );
        if (count === 0) {
          throw new Error("Artifact Blob changed while it was being read");
        }
        digest.update(buffer.subarray(0, count));
        offset += count;
      }
      return { sha256: digest.digest("hex"), size: info.size };
    } finally {
      closeSync(descriptor);
    }
  }

  public readVerified(
    storageKey: string,
    expectedSha256: string,
    expectedSize: number
  ): Buffer {
    const target = this.resolve(storageKey);
    this.requireRegular(target);
    const descriptor = openSync(target, constants.O_RDONLY | noFollow);
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.size !== expectedSize) {
        throw new Error("Artifact Blob size does not match its sealed metadata");
      }
      const source = Buffer.alloc(expectedSize);
      let offset = 0;
      while (offset < source.length) {
        const count = readSync(
          descriptor,
          source,
          offset,
          source.length - offset,
          offset
        );
        if (count === 0) {
          throw new Error("Artifact Blob changed while it was being read");
        }
        offset += count;
      }
      if (createHash("sha256").update(source).digest("hex") !== expectedSha256) {
        throw new Error("Artifact Blob digest does not match its sealed metadata");
      }
      return source;
    } finally {
      closeSync(descriptor);
    }
  }

  public seal(
    temporaryStorageKey: string,
    sealedStorageKey: string,
    expectedSha256: string,
    expectedSize: number
  ): void {
    const temporary = this.resolve(temporaryStorageKey);
    const sealed = this.resolve(sealedStorageKey);
    mkdirSync(path.dirname(sealed), { recursive: true, mode: 0o700 });

    if (existsSync(sealed)) {
      this.assertDigest(sealedStorageKey, expectedSha256, expectedSize);
      if (existsSync(temporary)) {
        this.requireRegular(temporary);
        rmSync(temporary);
        this.syncDirectory(path.dirname(temporary));
      }
      return;
    }

    this.assertDigest(temporaryStorageKey, expectedSha256, expectedSize);
    renameSync(temporary, sealed);
    const descriptor = openSync(sealed, constants.O_RDONLY | noFollow);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.syncDirectory(path.dirname(sealed));
    this.syncDirectory(path.dirname(temporary));
  }

  public discardUpload(storageKey: string): void {
    const target = this.resolve(storageKey);
    if (!existsSync(target)) return;
    this.requireRegular(target);
    rmSync(target);
    this.syncDirectory(path.dirname(target));
  }

  public discardExpiredUpload(storageKey: string): void {
    const target = this.resolve(storageKey);
    if (!existsSync(target)) return;
    const info = lstatSync(target);
    if (info.isDirectory()) {
      throw new Error("Expired Artifact upload entry must not be a directory");
    }
    rmSync(target);
    this.syncDirectory(path.dirname(target));
  }

  private assertDigest(
    storageKey: string,
    expectedSha256: string,
    expectedSize: number
  ): void {
    const actual = this.digest(storageKey);
    if (actual.sha256 !== expectedSha256 || actual.size !== expectedSize) {
      throw new Error("Artifact Blob digest does not match its declaration");
    }
  }

  private requireRegular(target: string) {
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Artifact Blob storage entry is not a regular file");
    }
    return info;
  }

  private resolve(storageKey: string): string {
    if (
      storageKey.length === 0 || storageKey.length > 512 ||
      path.isAbsolute(storageKey) || storageKey.split(/[\\/]/u).includes("..")
    ) {
      throw new Error("Artifact Blob storage key is invalid");
    }
    const resolved = path.resolve(this.root, storageKey);
    if (!resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Artifact Blob storage key escaped its root");
    }
    return resolved;
  }

  private syncDirectory(directory: string): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(directory, constants.O_RDONLY);
      fsyncSync(descriptor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "EBADF" && code !== "EPERM") {
        throw error;
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}
