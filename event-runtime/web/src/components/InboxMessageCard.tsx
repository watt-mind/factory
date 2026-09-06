import { Fragment, type ReactNode } from "react";

type MessageBlock =
  | { type: "paragraph"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "callout"; tone: "note" | "warning"; lines: string[] }
  | { type: "code"; lines: string[] };

type MessageSection = { heading: string | null; blocks: MessageBlock[] };

const heading = /^(#{1,3})\s+(.+)$/;
const unordered = /^[-*+]\s+(.+)$/;
const ordered = /^\d+[.)]\s+(.+)$/;
const callout = /^(?:>\s*|(?:note|info|tip|warning|caution):\s*)(.+)$/i;
const link = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const emphasis = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/**
 * Converts a plain inbox body into a small, safe Markdown subset. Inbox content
 * is operational text, so this deliberately never injects HTML.
 */
export function parseInboxMessage(body: string): MessageSection[] {
  const sections: MessageSection[] = [{ heading: null, blocks: [] }];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let calloutLines: string[] | null = null;
  let calloutTone: "note" | "warning" = "note";
  let codeLines: string[] | null = null;

  const section = () => sections.at(-1)!;
  const flush = () => {
    if (paragraph.length)
      section().blocks.push({ type: "paragraph", lines: paragraph });
    if (list) section().blocks.push({ type: "list", ...list });
    if (calloutLines)
      section().blocks.push({
        type: "callout",
        tone: calloutTone,
        lines: calloutLines,
      });
    if (codeLines) section().blocks.push({ type: "code", lines: codeLines });
    paragraph = [];
    list = null;
    calloutLines = null;
    calloutTone = "note";
    codeLines = null;
  };

  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^```/.test(line)) {
      if (codeLines) {
        flush();
      } else {
        flush();
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }
    const title = heading.exec(line);
    if (title) {
      flush();
      sections.push({ heading: title[2], blocks: [] });
      continue;
    }
    const quoted = callout.exec(line);
    if (quoted) {
      if (paragraph.length || list) flush();
      calloutLines ??= [];
      if (/^(?:>\s*)?(warning|caution):/i.test(line)) calloutTone = "warning";
      calloutLines.push(quoted[1].replace(/^(warning|caution):\s*/i, ""));
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const unorderedItem = unordered.exec(line);
    const orderedItem = ordered.exec(line);
    if (unorderedItem || orderedItem) {
      if (paragraph.length || calloutLines) flush();
      const orderedList = Boolean(orderedItem);
      if (!list || list.ordered !== orderedList) {
        if (list) flush();
        list = { ordered: orderedList, items: [] };
      }
      list.items.push((orderedItem ?? unorderedItem)![1]);
      continue;
    }
    if (list || calloutLines) flush();
    paragraph.push(line);
  }
  flush();
  return sections.filter((item) => item.heading || item.blocks.length);
}

function inlineMarkdown(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(link)) {
    if (match.index! > cursor)
      parts.push(...inlineEmphasis(text.slice(cursor, match.index!)));
    parts.push(
      <a
        key={`link-${match.index}`}
        href={match[2]}
        target="_blank"
        rel="noreferrer"
        className="text-(--accent) underline underline-offset-2"
      >
        {match[1]}
      </a>,
    );
    cursor = match.index! + match[0].length;
  }
  if (cursor < text.length || !parts.length)
    parts.push(...inlineEmphasis(text.slice(cursor)));
  return parts;
}

function inlineEmphasis(text: string): ReactNode[] {
  return text
    .split(emphasis)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("**"))
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("`"))
        return (
          <code key={index} className="rounded bg-(--surface-2) px-1 mono">
            {part.slice(1, -1)}
          </code>
        );
      return <Fragment key={index}>{part}</Fragment>;
    });
}

export function InboxMessageCard({
  title,
  body,
}: {
  title: string;
  body: string | null;
}) {
  const sections = body ? parseInboxMessage(body) : [];
  return (
    <article
      data-testid="inbox-message"
      className="rounded-md border border-(--border) bg-(--surface-0) px-3 py-2 text-[12px] leading-relaxed"
    >
      <h3 className="font-medium text-(--text)">{title}</h3>
      {sections.map((section, sectionIndex) => (
        <section
          key={`${section.heading ?? "body"}-${sectionIndex}`}
          className="mt-2 first:mt-1.5"
        >
          {section.heading && (
            <h4 className="rounded bg-(--surface-1) px-2 py-1 font-medium text-(--text)">
              {section.heading}
            </h4>
          )}
          {section.blocks.map((block, blockIndex) => {
            const key = `${block.type}-${blockIndex}`;
            if (block.type === "paragraph")
              return (
                <p
                  key={key}
                  className="mt-1.5 whitespace-pre-wrap break-words text-(--text-dim)"
                >
                  {inlineMarkdown(block.lines.join("\n"))}
                </p>
              );
            if (block.type === "code")
              return (
                <pre
                  key={key}
                  className="mt-1.5 overflow-x-auto rounded bg-(--surface-2) p-2 mono text-(--text-dim)"
                >
                  {block.lines.join("\n")}
                </pre>
              );
            if (block.type === "list") {
              const List = block.ordered ? "ol" : "ul";
              return (
                <List
                  key={key}
                  className={`mt-1.5 list-inside text-(--text-dim) ${block.ordered ? "list-decimal" : "list-disc"}`}
                >
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex}>{inlineMarkdown(item)}</li>
                  ))}
                </List>
              );
            }
            return (
              <aside
                key={key}
                role="note"
                className={`mt-1.5 rounded border-l-2 px-2 py-1.5 text-(--text-dim) ${block.tone === "warning" ? "border-(--hue-warn) bg-(--hue-warn)/10" : "border-(--accent) bg-(--accent)/10"}`}
              >
                <span className="mr-1 rounded bg-(--surface-2) px-1 py-0.5 text-[11px] font-medium uppercase">
                  {block.tone}
                </span>
                {inlineMarkdown(block.lines.join("\n"))}
              </aside>
            );
          })}
        </section>
      ))}
    </article>
  );
}
