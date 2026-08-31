import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { Locale } from "../../i18n.js";

/** Presentation only. Feature controllers retain command and credential ownership. */
export function PanelDialog({ title, locale, children, onClose, error, focusKey }: {
  title: string; locale: Locale; children: ReactNode; onClose: () => void; error?: string | null | undefined; focusKey?: string;
}) {
  const id = useId();
  const card = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = document.querySelector(".product-shell");
    const wasInert = background?.hasAttribute("inert");
    background?.setAttribute("inert", "");
    card.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const controls = [...(card.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]'
      ) ?? [])].filter((element) => {
        const closed = element.closest('details:not([open])');
        return !element.closest('[hidden], [inert]') && element.getAttribute("type") !== "hidden" &&
          (!closed || (element.tagName === "SUMMARY" && element.parentElement === closed));
      });
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) { event.preventDefault(); card.current?.focus(); return; }
      const outside = !card.current?.contains(document.activeElement);
      if (event.shiftKey && (outside || document.activeElement === first || document.activeElement === card.current)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (outside || document.activeElement === last || document.activeElement === card.current)) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (!wasInert) background?.removeAttribute("inert");
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => { card.current?.focus(); }, [focusKey]);
  return createPortal(
    <div className="modal-backdrop product-dialog-backdrop">
      <div aria-labelledby={id} aria-modal="true" className="modal-card product-dialog" ref={card} role="dialog" tabIndex={-1}>
        <header className="product-dialog-heading"><h2 id={id}>{title}</h2><button aria-label={locale === "zh-CN" ? "关闭" : "Close"} onClick={onClose} type="button">×</button></header>
        {error && <p className="error-banner" role="alert">{error}</p>}
        {children}
      </div>
    </div>, document.body
  );
}
