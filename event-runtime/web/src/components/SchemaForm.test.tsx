import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { renderWithClient } from "../test-render";
import {
  SchemaForm,
  humanizeDuration,
  schemaSearchText,
  secretEnvVar,
  secretState,
  type JsonSchema,
} from "./SchemaForm";

afterEach(cleanup);

const schema: JsonSchema = {
  type: "object",
  properties: {
    enabled: {
      type: "boolean",
      title: "Enabled",
      description: "master switch",
      default: true,
    },
    mode: {
      type: "string",
      enum: ["echo", "silent"],
      title: "Mode",
      default: "echo",
    },
    maxParallel: {
      type: "integer",
      title: "Max parallel",
      minimum: 1,
      maximum: 4,
      default: 1,
    },
    apiToken: {
      type: "string",
      format: "secret",
      title: "API token",
      description: "never shown",
    },
    webhookUrl: {
      type: "string",
      format: "uri",
      title: "Webhook URL",
    },
    notifyChannel: {
      type: "string",
      format: "channel-id",
      title: "Notify channel",
    },
    relatedTicket: {
      type: "string",
      format: "ticket",
      title: "Related ticket",
    },
    pollEvery: {
      type: "string",
      format: "duration",
      title: "Poll interval",
    },
    notes: {
      type: "string",
      format: "multiline",
      title: "Notes",
    },
    contact: {
      type: "string",
      format: "email",
      title: "Contact",
    },
  },
};

const values = {
  enabled: true,
  mode: "echo",
  maxParallel: 1,
  apiToken: { set: true, source: "env" as const },
  webhookUrl: "https://example.test/hook",
  notifyChannel: "ops-alerts",
  relatedTicket: "WM-920",
  pollEvery: "30s",
  notes: "line one\nline two",
  contact: "ops@example.test",
};

describe("SchemaForm helpers", () => {
  test("secret env var is FACTORY_EXT_<NAMESPACE>_<KEY> in upper-snake", () => {
    expect(secretEnvVar("sample", ["apiToken"])).toBe(
      "FACTORY_EXT_SAMPLE_API_TOKEN",
    );
    expect(secretEnvVar("mobile", ["limits", "signingKey"])).toBe(
      "FACTORY_EXT_MOBILE_LIMITS_SIGNING_KEY",
    );
  });

  test("humanizeDuration expands the closed duration grammar", () => {
    expect(humanizeDuration("1s")).toBe("1 second");
    expect(humanizeDuration("30s")).toBe("30 seconds");
    expect(humanizeDuration("2h")).toBe("2 hours");
    expect(humanizeDuration("nope")).toBe("nope");
  });

  test("secretState never treats a leaked string as displayable", () => {
    expect(secretState({ set: false, source: null })).toEqual({
      set: false,
      source: null,
    });
    expect(secretState({ set: true, source: "secrets.env" }).set).toBe(true);
    expect(secretState("sk-live-leak")).toEqual({ set: true, source: null });
  });

  test("schemaSearchText indexes title and description of every property", () => {
    const haystack = schemaSearchText(schema);
    expect(haystack).toContain("API token");
    expect(haystack).toContain("never shown");
    expect(haystack).toContain("Webhook URL");
  });
});

describe("SchemaForm", () => {
  test("renders a widget per type and format, never the secret value", () => {
    const view = renderWithClient(
      <SchemaForm schema={schema} values={values} namespace="sample" />,
    );

    expect(view.getByText("Enabled")).toBeTruthy();
    expect(
      view
        .getByRole("switch", { name: "Enabled" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      view
        .getByRole("switch", { name: "Enabled" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    const select = view.getByLabelText("Mode") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("echo");

    expect(view.getByText("1")).toBeTruthy();
    expect(view.getByText("1–4")).toBeTruthy();
    expect(view.getAllByText("default").length).toBeGreaterThan(0);

    expect(view.getByText("FACTORY_EXT_SAMPLE_API_TOKEN")).toBeTruthy();
    expect(view.queryByText("sk-live")).toBeNull();
    expect(view.getByText("never shown")).toBeTruthy();

    const link = view.getByRole("link", {
      name: "https://example.test/hook",
    });
    expect(link.getAttribute("href")).toBe("https://example.test/hook");

    expect(view.getByText("ops-alerts")).toBeTruthy();
    expect(view.getByText("WM-920")).toBeTruthy();
    expect(view.getByText("30 seconds")).toBeTruthy();
    expect(view.container.querySelector("pre")?.textContent).toBe(
      "line one\nline two",
    );
    expect(view.getByText("ops@example.test")).toBeTruthy();
  });

  test("unset secrets render an unset badge, not a value", () => {
    const view = renderWithClient(
      <SchemaForm
        schema={{
          type: "object",
          properties: {
            apiToken: { type: "string", format: "secret", title: "API token" },
          },
        }}
        values={{ apiToken: { set: false, source: null } }}
        namespace="sample"
      />,
    );
    expect(view.getByText("unset")).toBeTruthy();
    expect(view.queryByText("FACTORY_EXT_SAMPLE_API_TOKEN")).toBeNull();
  });
});
