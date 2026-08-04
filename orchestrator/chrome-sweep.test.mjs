/**
 * bun test
 *
 * The sweep kills processes, and the one unforgivable failure is killing the
 * human's actual Chrome. Every fence gets a test proving it holds.
 */
import { test, expect } from "bun:test";
import { classify, parsePs } from "./chrome-sweep.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("an orphaned agent Chrome (reparented to launchd) is flagged", () => {
  const { orphans } = classify([
    { pid: 500, ppid: 1, command: `${CHROME} --user-data-dir=/Users/x/.cache/chrome-devtools-mcp/chrome-profile --headless` },
  ]);
  expect(orphans).toHaveLength(1);
  expect(orphans[0].pid).toBe(500);
});

test("an isolated temp profile from a killed run is flagged too", () => {
  const { orphans } = classify([
    { pid: 501, ppid: 1, command: `${CHROME} --user-data-dir=/var/folders/pd/T/puppeteer_dev_chrome_profile-Xa1B2c` },
  ]);
  expect(orphans).toHaveLength(1);
});

test("the human's normal Chrome is NEVER touched, even at ppid 1", () => {
  // Real desktop Chrome is launched by launchd, so ppid 1 is its normal state —
  // the profile fence is what protects it, not the parent check.
  const { orphans, live } = classify([
    { pid: 600, ppid: 1, command: `${CHROME}` },
    { pid: 601, ppid: 1, command: `${CHROME} --user-data-dir=/Users/x/Library/Application Support/Google/Chrome` },
  ]);
  expect(orphans).toHaveLength(0);
  expect(live).toHaveLength(0);
});

test("an agent Chrome whose MCP server is alive is left alone", () => {
  const { orphans, live } = classify([
    { pid: 700, ppid: 42371, command: `${CHROME} --user-data-dir=/var/folders/T/chrome-devtools-mcp-tmp-abc --headless` },
  ]);
  expect(orphans).toHaveLength(0);
  expect(live).toHaveLength(1);
});

test("helper processes are skipped — killing the main brings them down", () => {
  const { orphans } = classify([
    { pid: 800, ppid: 1, command: `${CHROME} --type=renderer --user-data-dir=/x/chrome-devtools-mcp/chrome-profile` },
    { pid: 801, ppid: 1, command: `${CHROME} --type=gpu-process --user-data-dir=/x/chrome-devtools-mcp/chrome-profile` },
  ]);
  expect(orphans).toHaveLength(0);
});

test("parsePs handles ps output with leading whitespace and spaces in commands", () => {
  const rows = parsePs(`  123     1 ${CHROME} --user-data-dir=/x/chrome-devtools-mcp/p\n 45  6789 /usr/bin/tail -f log\n\n`);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({ pid: 123, ppid: 1, command: `${CHROME} --user-data-dir=/x/chrome-devtools-mcp/p` });
});
