import { describe, expect, test } from "bun:test";
import { createLruCache } from "./lru-cache.mjs";

describe("createLruCache", () => {
  test("evicts the least recently used entry at capacity", () => {
    const cache = createLruCache({ limit: 2 });
    cache.set("first", 1);
    cache.set("second", 2);
    expect(cache.get("first")).toBe(1);

    cache.set("third", 3);

    expect(cache.size).toBe(2);
    expect(cache.get("first")).toBe(1);
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("third")).toBe(3);
  });

  test("expires entries on read", () => {
    const cache = createLruCache({ limit: 2, ttlMs: 1_000 });
    cache.set("ticket", "cached", 10);

    expect(cache.get("ticket", 1_009)).toBe("cached");
    expect(cache.get("ticket", 1_010)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("refreshes recency when an existing key is set again", () => {
    const cache = createLruCache({ limit: 2 });
    cache.set("first", 1);
    cache.set("second", 2);
    cache.set("first", 3);
    cache.set("third", 4);

    expect(cache.size).toBe(2);
    expect(cache.get("first")).toBe(3);
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("third")).toBe(4);
  });
});
