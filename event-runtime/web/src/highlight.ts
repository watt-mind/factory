export type JsonTokenKind =
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "punct"
  | "plain";

export interface JsonToken {
  kind: JsonTokenKind;
  text: string;
}

const JSON_TOKEN_REGEX =
  /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false)\b|\b(null)\b|([{}[\],])/g;

/**
 * Tokenizes JSON text into semantic token spans for syntax highlighting.
 * Preserves all original characters, whitespace, and formatting exactly.
 */
export function tokenizeJson(json: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let lastIndex = 0;

  let match: RegExpExecArray | null;
  JSON_TOKEN_REGEX.lastIndex = 0;

  while ((match = JSON_TOKEN_REGEX.exec(json)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: "plain", text: json.slice(lastIndex, match.index) });
    }

    const [full] = match;

    if (match[1]) {
      // Quoted string — check if it is an object key followed by a colon
      const colonIdx = full.lastIndexOf(":");
      if (colonIdx !== -1 && full.slice(colonIdx).trim() === ":") {
        const keyPart = full.slice(0, colonIdx);
        const colonPart = full.slice(colonIdx);
        tokens.push({ kind: "key", text: keyPart });
        tokens.push({ kind: "punct", text: colonPart });
      } else {
        tokens.push({ kind: "string", text: full });
      }
    } else if (match[2]) {
      tokens.push({ kind: "number", text: full });
    } else if (match[3]) {
      tokens.push({ kind: "boolean", text: full });
    } else if (match[4]) {
      tokens.push({ kind: "null", text: full });
    } else if (match[5]) {
      tokens.push({ kind: "punct", text: full });
    }

    lastIndex = JSON_TOKEN_REGEX.lastIndex;
  }

  if (lastIndex < json.length) {
    tokens.push({ kind: "plain", text: json.slice(lastIndex) });
  }

  return tokens;
}

/** Semantic token styling using the app's OKLCH color system. */
export const TOKEN_CLASSES: Record<JsonTokenKind, string> = {
  key: "text-(--text) font-medium",
  string: "text-(--hue-ok)",
  number: "text-(--hue-info)",
  boolean: "text-(--hue-warn) font-medium",
  null: "text-(--hue-err) font-medium",
  punct: "text-(--text-faint)",
  plain: "",
};
