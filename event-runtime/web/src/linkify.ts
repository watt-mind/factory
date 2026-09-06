import { issueUrl } from "./trackerLinks";

export type LinkifiedPart =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string; title: string };

// GitHub owners never contain "." — a dotted owner segment is a hostname or a
// path, and a repo segment ending in a file extension is a path fragment.
const CANDIDATE =
  /https?:\/\/[^\s<>"']+|[A-Z]{2,5}-\d+|[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9.-]*#[1-9]\d*/g;
const FILE_EXTENSION = /\.(md|mjs|js|ts|tsx|json|yaml|yml|sh)$/i;
const TRAILING_PUNCTUATION = /[.,!?;:\]\}]+$/;
const GITHUB_PR =
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

function splitTrailingPunctuation(candidate: string): [string, string] {
  let link = candidate;
  let trailing = "";

  const punctuation = TRAILING_PUNCTUATION.exec(link);
  if (punctuation) {
    trailing = punctuation[0];
    link = link.slice(0, -trailing.length);
  }

  while (link.endsWith(")")) {
    const opens = (link.match(/\(/g) ?? []).length;
    const closes = (link.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    link = link.slice(0, -1);
    trailing = `)${trailing}`;
  }

  return [link, trailing];
}

function pushText(parts: LinkifiedPart[], text: string) {
  if (!text) return;
  const previous = parts[parts.length - 1];
  if (previous?.kind === "text") {
    previous.text += text;
  } else {
    parts.push({ kind: "text", text });
  }
}

/** Split prose into safe render tokens without interpreting markdown or code. */
export function linkifyText(text: string): LinkifiedPart[] {
  const parts: LinkifiedPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(CANDIDATE)) {
    const index = match.index;
    const candidate = match[0];
    pushText(parts, text.slice(cursor, index));

    if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
      const [href, trailing] = splitTrailingPunctuation(candidate);
      const pr = GITHUB_PR.exec(href);
      parts.push({
        kind: "link",
        text: pr ? `${pr[1]}/${pr[2]}#${pr[3]}` : href,
        href,
        title: href,
      });
      pushText(parts, trailing);
    } else {
      const before = text[index - 1] ?? "";
      const after = text[index + candidate.length] ?? "";
      const slashForm = candidate.includes("/");
      // A dotted prefix (`example.com/repo#1`) means the owner segment is a
      // hostname, so "." is a leading boundary for the slash form only.
      const leadingBoundary = slashForm ? /[A-Za-z0-9_.\/-]/ : /[A-Za-z0-9_-]/;
      const trailingBoundary = slashForm ? /[A-Za-z0-9_\/-]/ : /[A-Za-z0-9_-]/;
      const hash = candidate.indexOf("#");
      const isPathFragment =
        slashForm && FILE_EXTENSION.test(candidate.slice(0, hash));
      const href = isPathFragment ? null : issueUrl(candidate);
      if (
        !href ||
        leadingBoundary.test(before) ||
        trailingBoundary.test(after)
      ) {
        pushText(parts, candidate);
      } else {
        parts.push({
          kind: "link",
          text: candidate,
          href,
          title: candidate,
        });
      }
    }

    cursor = index + candidate.length;
  }

  pushText(parts, text.slice(cursor));
  return parts.length > 0 ? parts : [{ kind: "text", text }];
}
