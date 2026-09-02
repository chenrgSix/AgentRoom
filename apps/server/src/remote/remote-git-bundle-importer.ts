import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RemoteProviderClientError } from "./remote-provider-client.js";

const run = promisify(execFile);
const maxBytes = 4 * 1024 * 1024;

export interface RemoteGitBundleExpectation {
  objectFormat: "sha1" | "sha256";
  baseCommit: string;
  candidateCommit: string;
  candidateTree: string;
  bundleDigest: string;
  bundleByteLength: number;
}

export interface ValidatedRemoteGitBundle {
  patch: Buffer;
  patchDigest: string;
}

function gitEnvironment(root: string, config: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: config,
    GIT_TERMINAL_PROMPT: "0"
  };
}

/** Validates a complete fixed-ref bundle with real Git and always removes its owned root. */
export async function validateRemoteGitBundle(
  source: Buffer,
  expected: RemoteGitBundleExpectation,
  options: { gitExecutable?: string; temporaryBase?: string } = {}
): Promise<ValidatedRemoteGitBundle> {
  if (source.length < 1 || source.length > maxBytes ||
    source.length !== expected.bundleByteLength ||
    createHash("sha256").update(source).digest("hex") !== expected.bundleDigest) {
    throw new RemoteProviderClientError("REMOTE_PROVIDER_BUNDLE_DIGEST_MISMATCH");
  }
  const root = await mkdtemp(path.join(
    options.temporaryBase ?? tmpdir(), "convenewire-remote-git-"
  ));
  const git = options.gitExecutable ?? "git";
  const repository = path.join(root, "repository.git");
  const bundle = path.join(root, "candidate.bundle");
  const config = path.join(root, "empty.gitconfig");
  const env = gitEnvironment(root, config);
  try {
    await writeFile(config, "", { mode: 0o600 });
    await writeFile(bundle, source, { mode: 0o600 });
    await run(git, ["init", "--bare", `--object-format=${expected.objectFormat}`, repository], {
      env, timeout: 15_000, maxBuffer: maxBytes
    });
    const heads = await run(git, ["bundle", "list-heads", bundle], {
      cwd: repository, env, timeout: 15_000, maxBuffer: maxBytes
    });
    const listed = heads.stdout.trim().split("\n").filter(Boolean).sort();
    const wanted = [
      `${expected.baseCommit} refs/heads/base`,
      `${expected.candidateCommit} refs/heads/candidate`
    ].sort();
    if (listed.length !== wanted.length || listed.some((line, index) => line !== wanted[index])) {
      throw new RemoteProviderClientError("REMOTE_PROVIDER_BUNDLE_REFS_INVALID");
    }
    await run(git, ["fetch", "--no-tags", bundle,
      "refs/heads/base:refs/remotes/evidence/base",
      "refs/heads/candidate:refs/remotes/evidence/candidate"], {
      cwd: repository, env, timeout: 15_000, maxBuffer: maxBytes
    });
    for (const object of [expected.baseCommit, expected.candidateCommit]) {
      const type = await run(git, ["cat-file", "-t", object], {
        cwd: repository, env, timeout: 15_000, maxBuffer: maxBytes
      });
      if (type.stdout.trim() !== "commit") {
        throw new RemoteProviderClientError("REMOTE_PROVIDER_GIT_OBJECT_INVALID");
      }
    }
    const tree = await run(git, ["rev-parse", `${expected.candidateCommit}^{tree}`], {
      cwd: repository, env, timeout: 15_000, maxBuffer: maxBytes
    });
    if (tree.stdout.trim() !== expected.candidateTree) {
      throw new RemoteProviderClientError("REMOTE_PROVIDER_TREE_MISMATCH");
    }
    try {
      await run(git, ["merge-base", "--is-ancestor",
        expected.baseCommit, expected.candidateCommit], {
        cwd: repository, env, timeout: 15_000, maxBuffer: maxBytes
      });
    } catch {
      throw new RemoteProviderClientError("REMOTE_PROVIDER_BASE_NOT_ANCESTOR");
    }
    const diff = await run(git, ["diff", "--binary", "--full-index",
      expected.baseCommit, expected.candidateCommit, "--", "."], {
      cwd: repository, env, timeout: 15_000, maxBuffer: maxBytes,
      encoding: "buffer"
    });
    const patch = Buffer.from(diff.stdout);
    if (patch.length < 1 || patch.length > maxBytes) {
      throw new RemoteProviderClientError("REMOTE_PROVIDER_PATCH_TOO_LARGE");
    }
    return {
      patch,
      patchDigest: createHash("sha256").update(patch).digest("hex")
    };
  } catch (error) {
    if (error instanceof RemoteProviderClientError) throw error;
    throw new RemoteProviderClientError("REMOTE_PROVIDER_GIT_VALIDATION_FAILED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
