import type { ComponentPropsWithoutRef } from "react";
import React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownMessageProps {
  content: string;
  onInternalNavigate?: (href: string) => void;
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

export function MarkdownMessage({
  content,
  onInternalNavigate,
  streaming = false
}: MarkdownMessageProps) {
  const components: Components = {
    ...markdownComponents,
    a({ children, href, node: _node, ...properties }) {
      const external = opensInNewContext(href);
      return (
        <a
          {...properties}
          href={href}
          onClick={onInternalNavigate && href?.startsWith("/?")
            ? (event) => {
                event.preventDefault();
                onInternalNavigate(href);
              }
            : undefined}
          {...(external ? { rel: "noreferrer noopener", target: "_blank" } : {})}
        >
          {children}
        </a>
      );
    }
  };
  return (
    <div
      aria-busy={streaming || undefined}
      className={streaming ? "markdown-message streaming" : "markdown-message"}
    >
      <Markdown
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {content}
      </Markdown>
    </div>
  );
}
