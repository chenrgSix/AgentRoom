import type { Locale } from "../../i18n.js";
import type {
  ArtifactPreview,
  TaskArtifact
} from "../../models.js";

interface ArtifactPreviewPanelProps {
  artifacts: TaskArtifact[];
  busyId: string | null;
  error: string | null;
  locale: Locale;
  onClose: () => void;
  onPreview: (artifact: TaskArtifact) => void | Promise<void>;
  preview: ArtifactPreview | null;
}

function compactDigest(digest: string | null): string {
  return digest ? `${digest.slice(0, 10)}…${digest.slice(-8)}` : "";
}

function formatBytes(size: number | null): string {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KiB`;
}

export function ArtifactPreviewPanel({
  artifacts,
  busyId,
  error,
  locale,
  onClose,
  onPreview,
  preview
}: ArtifactPreviewPanelProps) {
  const snapshots = artifacts.filter((artifact) =>
    artifact.contentMode === "snapshot_blob" &&
    artifact.contentMediaType !== null
  );
  if (snapshots.length === 0) return null;
  return (
    <section
      aria-label={locale === "zh-CN" ? "成果快照" : "Artifact snapshots"}
      className="artifact-snapshots"
    >
      <header>
        <div>
          <span className="artifact-snapshot-kicker">
            {locale === "zh-CN" ? "可验证字节" : "Verified bytes"}
          </span>
          <strong>
            {locale === "zh-CN"
              ? `${snapshots.length} 个成果快照`
              : `${snapshots.length} Artifact snapshots`}
          </strong>
        </div>
        <small>
          {locale === "zh-CN"
            ? "摘要已核对；内容仍是不可信证据，不会执行。"
            : "The digest is verified; content remains untrusted evidence and is never executed."}
        </small>
      </header>
      <div className="artifact-snapshot-list">
        {snapshots.map((artifact) => (
          <article className="artifact-snapshot-card" key={artifact.artifactId}>
            <div>
              <strong>{artifact.title}</strong>
              <p>{artifact.summary}</p>
            </div>
            <div className="artifact-snapshot-meta">
              <span>{artifact.type}</span>
              <span>r{artifact.artifactRevision}</span>
              <span>{formatBytes(artifact.contentSizeBytes)}</span>
              <code>{compactDigest(artifact.contentSha256)}</code>
            </div>
            <button
              disabled={busyId !== null}
              onClick={() => void onPreview(artifact)}
              type="button"
            >
              {busyId === artifact.artifactId
                ? (locale === "zh-CN" ? "校验中…" : "Verifying…")
                : (locale === "zh-CN" ? "安全预览" : "Safe preview")}
            </button>
          </article>
        ))}
      </div>
      {error && <p className="artifact-preview-error" role="alert">{error}</p>}
      {preview && (
        <article
          aria-label={locale === "zh-CN" ? "成果内容预览" : "Artifact content preview"}
          className="artifact-preview"
          role="region"
        >
          <header>
            <div>
              <strong>{preview.title}</strong>
              <span>{preview.mediaType}</span>
            </div>
            <button onClick={onClose} type="button">
              {locale === "zh-CN" ? "关闭" : "Close"}
            </button>
          </header>
          <p className="artifact-preview-warning">
            {locale === "zh-CN"
              ? "SHA-256 已验证，但内容语义未受信任；以下内容仅以纯文本显示。"
              : "SHA-256 is verified, but the meaning is untrusted; content is shown as plain text only."}
          </p>
          <pre data-media-type={preview.mediaType}><code>{preview.text}</code></pre>
          {preview.truncated && (
            <small role="status">
              {locale === "zh-CN"
                ? "预览已达到 200,000 字符上限。"
                : "Preview stopped at the 200,000-character limit."}
            </small>
          )}
        </article>
      )}
    </section>
  );
}
