import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderQuickstartGif } from "./render-gif.mjs";

const GIF = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../docs/media/quickstart.gif",
);

test("quickstart GIF is GIF89a and loops", () => {
  const bytes = renderQuickstartGif();
  expect(Buffer.from(bytes.subarray(0, 6)).toString("ascii")).toBe("GIF89a");
  expect(bytes[bytes.length - 1]).toBe(0x3b);
  const committed = readFileSync(GIF);
  expect(Buffer.from(committed)).toEqual(Buffer.from(bytes));
});
