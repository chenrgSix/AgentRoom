import type { ComponentPropsWithoutRef } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownMessageProps {
  content: string;
  streaming?: boolean;
}

function opensInNewContext(href: string | undefined): boolean {
  if (!href || !/^https?:\/\//iu.test(href)) return false;
  try {
    const base = typeof window === "undefined"
      ? new URL("http://localhost/")
      : new URL(window.location.href);
    return new URL(href, base).origin !== base.origin;
  } catch {
    return false;
  }
}

const markdownComponents: Components = {
  a({ children, href, node: _node, ...properties }) {
    const external = opensInNewContext(href);
    return (
      <a
        {...properties}
        href={href}
        {...(external ? { rel: "noreferrer noopener", target: "_blank" } : {})}
      >
        {children}
      </a>
    );
  },
  img({ alt, node: _node, src, ...properties }) {
    if (!src) return null;
    return (
      <img
        {...properties as ComponentPropsWithoutRef<"img">}
        alt={alt ?? ""}
        loading="lazy"
        referrerPolicy="no-referrer"
        src={src}
      />
    );
  },
  input({ node: _node, type, ...properties }) {
    return <input {...properties} disabled={type === "checkbox"} type={type} />;
  }
};

export function MarkdownMessage({ content, streaming = false }: MarkdownMessageProps) {
  return (
    <div
      aria-busy={streaming || undefined}
      className={streaming ? "markdown-message streaming" : "markdown-message"}
    >
      <Markdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {content}
      </Markdown>
    </div>
  );
}
