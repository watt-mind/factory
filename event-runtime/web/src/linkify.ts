import { issueUrl } from "./trackerLinks";

export type LinkifiedPart =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string; title: string };

const CANDIDATE =
  /https?:\/\/[^\s<>"']+|[A-Z]{2,5}-\d+|[A-Za-z0-9][A-Za-z0-9.-]*\/[A-Za-z0-9][A-Za-z0-9.-]*#[1-9]\d*/g;
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
      const identifierBoundary = candidate.includes("/")
        ? /[A-Za-z0-9_\/-]/
        : /[A-Za-z0-9_-]/;
      const href = issueUrl(candidate);
      if (
        !href ||
        identifierBoundary.test(before) ||
        identifierBoundary.test(after)
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
