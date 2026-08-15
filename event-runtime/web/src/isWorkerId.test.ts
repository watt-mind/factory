import { createElement } from "react";
import "./test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ActorRef, isWorkerId } from "./components/RunDetailBlocks";
import { shortId } from "./components/ui";

describe("isWorkerId", () => {
  test("static system actors and bare worker are not worker ids", () => {
    expect(isWorkerId("operator")).toBe(false);
    expect(isWorkerId("planner")).toBe(false);
    expect(isWorkerId("reaper")).toBe(false);
    expect(isWorkerId("worker")).toBe(false);
  });

  test("empty, prefix-only, and arbitrary actor strings are not worker ids", () => {
    expect(isWorkerId("")).toBe(false);
    expect(isWorkerId("worker_")).toBe(false);
    expect(isWorkerId("system")).toBe(false);
    expect(isWorkerId("unknown")).toBe(false);
    expect(isWorkerId("worker-123")).toBe(false);
  });

  test("minted worker ids (worker_<pid>_<8 hex>) match", () => {
    expect(isWorkerId("worker_12345_a1b2c3d4")).toBe(true);
    expect(isWorkerId("worker_42_deadbeef")).toBe(true);
    expect(isWorkerId("worker_99999_0f3b2a1c")).toBe(true);
  });

  test("short and test worker ids match", () => {
    expect(isWorkerId("worker_1")).toBe(true);
    expect(isWorkerId("worker_test")).toBe(true);
    expect(isWorkerId("worker_0f3b2a1c-9e8d-4b7a-8c6d-5e4f3a2b1c0d")).toBe(true);
  });
});

describe("ActorRef component", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  test.each(["operator", "planner", "reaper", "worker"])(
    "static actor '%s' renders inert text without jump link",
    (actor) => {
      const { container, queryByRole } = render(createElement(ActorRef, { actor }));
      expect(queryByRole("button")).toBeNull();
      expect(container.textContent).toBe(actor);
    },
  );

  test("minted worker id renders a jump link and updates hash on click", () => {
    const workerId = "worker_12345_a1b2c3d4";
    const { getByRole } = render(createElement(ActorRef, { actor: workerId }));
    const link = getByRole("button");
    expect(link.textContent).toBe(shortId(workerId));
    expect(link.getAttribute("title")).toBe(workerId);

    fireEvent.click(link);
    expect(window.location.hash).toBe(`#/workers/${workerId}`);
  });

  test("short worker id renders a jump link and updates hash on click", () => {
    const workerId = "worker_1";
    const { getByRole } = render(createElement(ActorRef, { actor: workerId }));
    const link = getByRole("button");
    expect(link.textContent).toBe(workerId);

    fireEvent.click(link);
    expect(window.location.hash).toBe(`#/workers/${workerId}`);
  });
});
