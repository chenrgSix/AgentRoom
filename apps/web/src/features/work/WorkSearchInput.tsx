import React, { useEffect, useRef, useState } from "react";
import type { Locale } from "../../i18n.js";

/** Local typing buffer only; navigation and Server query remain committed intent. */
export function WorkSearchInput({ value, locale, onChange }: {
  value: string; locale: Locale; onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [composing, setComposing] = useState(false);
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => {
    if (composing || draft.trim() === value.trim()) return;
    const timer = setTimeout(() => callback.current(draft.trim()), 250);
    return () => clearTimeout(timer);
  }, [draft, value, composing]);
  const zh = locale === "zh-CN";
  return <label className="work-search"><span id="work-search-label">{zh ? "搜索工作" : "Search work"}</span><input
    aria-describedby="work-search-help"
    aria-labelledby="work-search-label"
    onChange={(event) => setDraft([...event.target.value].slice(0, 100).join(""))}
    onCompositionStart={() => setComposing(true)}
    onCompositionEnd={(event) => { setDraft([...event.currentTarget.value].slice(0, 100).join("")); setComposing(false); }}
    placeholder={zh ? "任务标题或 TASK-24" : "Task title or TASK-24"}
    type="search" value={draft}
  /><small id="work-search-help">{zh ? "最多 100 字符，输入完成后搜索有权查看的任务。" : "Up to 100 characters. Searches authorized Tasks after you finish typing."}</small></label>;
}
