import { describe, expect, test } from "bun:test";
import {
  DECISION_REQUEST_SCHEMA,
  DECISION_RESPONSE_SCHEMA,
  EFFECT_REFS,
  EFFECTS,
  WIDGET_KINDS,
  decisionRequestHash,
  validateDecisionRequest,
  validateDecisionResponse,
} from "./decision.mjs";
import { validate } from "./schema.mjs";

const EXAMPLE_REQUEST = {
  schemaVersion: "factory.decision-request/v1",
  question: "WM-313 changes how the pi adapter reads FACTORY_EVENT_SECRET. May I proceed?",
  context:
    "The ticket moves secret handling from env to a file the worker mounts…\n\nRisk: a wrong path leaks the secret into the run journal.",
  recommended: "authorise",
  options: [
    {
      id: "authorise",
      label: "Authorise within these paths",
      description: "Re-dispatch me with your approval bound to WM-313 as written now.",
      effect: "authorise",
      tone: "primary",
      scope: {
        paths: [
          "event-runtime/lib/adapters/pi.mjs",
          "event-runtime/lib/security-env.mjs",
        ],
        summary:
          "Read the event secret from FACTORY_EVENT_SECRET_FILE when set; never log its value.",
      },
    },
    {
      id: "triage",
      label: "Send back to Triage",
      description: "The ticket should be re-scoped before anyone touches this.",
      effect: "send_to_triage",
      tone: "neutral",
    },
    {
      id: "dismiss",
      label: "Not now",
      effect: "dismiss",
      tone: "neutral",
    },
  ],
  fields: [
    {
      id: "insight",
      kind: "text",
      label: "Anything I should know before I start",
      placeholder: "e.g. the file path convention, or a test to add",
      required: false,
      maxLength: 2000,
    },
    {
      id: "paths",
      kind: "multi-choice",
      label: "Restrict me to",
      choices: [
        { id: "pi", label: "event-runtime/lib/adapters/pi.mjs" },
        { id: "env", label: "event-runtime/lib/security-env.mjs" },
      ],
      required: true,
      whenOption: ["authorise"],
    },
    {
      id: "confirm",
      kind: "confirm",
      label: "I understand this changes secret handling on every worker",
      required: true,
      whenOption: ["authorise"],
    },
  ],
};

const ALL_REFS = {
  issue: "WM-313",
  repo: "factory",
  runId: "run_313",
  eventSource: "linear",
  eventId: "delivery-313",
  proposalId: "prop_313",
};

const clone = (value) => structuredClone(value);

function dismissRequest(overrides = {}) {
  return {
    schemaVersion: "factory.decision-request/v1",
    question: "What should happen?",
    options: [{ id: "dismiss", label: "Dismiss", effect: "dismiss" }],
    ...overrides,
  };
}

function requestForEffect(effect) {
  const option = { id: "choice", label: "Choose", effect };
  if (effect === "authorise") {
    option.scope = { paths: ["event-runtime/lib/decision.mjs"], summary: "Validate decisions." };
  }
  const request = dismissRequest({ options: [option] });
  if (effect === "reject_proposal") {
    request.fields = [
      { id: "reason", kind: "text", label: "Reason", required: true, whenOption: ["choice"] },
    ];
  }
  return request;
}

function expectInvalid(request, refs = ALL_REFS) {
  const checked = validateDecisionRequest(request, { refs });
  expect(checked.valid).toBe(false);
  expect(checked.errors.length).toBeGreaterThan(0);
}

describe("contract schemas", () => {
  test("use only the closed keyword subset and close every object", () => {
    // An unsupported keyword is reported as an error by lib/schema.mjs, so a
    // clean run against any value proves the schema stays inside the subset.
    for (const schema of [DECISION_REQUEST_SCHEMA, DECISION_RESPONSE_SCHEMA]) {
      const errors = validate(schema, {}).errors;
      expect(errors.some((e) => e.includes("unsupported schema keyword"))).toBe(false);
    }
    const walk = (node, at) => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}[${i}]`));
      if (node.type === "object" && at !== "response.properties.fields") {
        expect(node.additionalProperties, `${at} must be closed`).toBe(false);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`);
    };
    walk(DECISION_REQUEST_SCHEMA, "request");
    walk(DECISION_RESPONSE_SCHEMA, "response");
    // The response's `fields` map is keyed by request-declared ids — closed by
    // the validator, not the schema.
    expect(DECISION_RESPONSE_SCHEMA.properties.fields.additionalProperties).toEqual({});
  });

  test("encode the closed effect and widget enums", () => {
    expect(DECISION_REQUEST_SCHEMA.properties.options.items.properties.effect.enum).toEqual(EFFECTS);
    expect(DECISION_REQUEST_SCHEMA.properties.fields.items.properties.kind.enum).toEqual(WIDGET_KINDS);
    expect(Object.keys(EFFECT_REFS)).toEqual(EFFECTS);
  });
});

describe("validateDecisionRequest", () => {
  test("accepts the §2.1 example verbatim", () => {
    expect(validateDecisionRequest(EXAMPLE_REQUEST, { refs: ALL_REFS })).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("enforces the top-level bounds and rejects unknown properties", () => {
    expect(validateDecisionRequest(dismissRequest(), { refs: {} }).valid).toBe(true);

    for (const request of [
      dismissRequest({ question: "" }),
      dismissRequest({ question: "x".repeat(281) }),
      dismissRequest({ context: "x".repeat(8193) }),
      dismissRequest({ context: "🙂".repeat(4096) }),
      dismissRequest({ options: [] }),
      dismissRequest({ options: Array.from({ length: 7 }, (_, id) => ({ id: `o${id}`, label: "x", effect: "dismiss" })) }),
      { ...dismissRequest(), unexpected: true },
    ]) {
      expectInvalid(request, {});
    }
  });

  test("enforces option shape, bounds, ids, and uniqueness", () => {
    for (const option of [
      { id: "Bad", label: "x", effect: "dismiss" },
      { id: "ok", label: "", effect: "dismiss" },
      { id: "ok", label: "x".repeat(61), effect: "dismiss" },
      { id: "ok", label: "x", description: "x".repeat(281), effect: "dismiss" },
      { id: "ok", label: "x", effect: "invented" },
      { id: "ok", label: "x", effect: "dismiss", tone: "loud" },
      { id: "ok", label: "x", effect: "dismiss", extra: true },
    ]) {
      expectInvalid(dismissRequest({ options: [option] }), {});
    }
    expectInvalid(
      dismissRequest({
        options: [
          { id: "same", label: "One", effect: "dismiss" },
          { id: "same", label: "Two", effect: "dismiss" },
        ],
      }),
      {},
    );
  });

  test("recommended and whenOption name existing unique options", () => {
    expect(validateDecisionRequest(dismissRequest({ recommended: "dismiss" }), { refs: {} }).valid).toBe(true);
    expectInvalid(dismissRequest({ recommended: "missing" }), {});
    expect(
      validateDecisionRequest(
        dismissRequest({ fields: [{ id: "note", kind: "text", label: "Note", whenOption: ["dismiss"] }] }),
        { refs: {} },
      ).valid,
    ).toBe(true);
    expectInvalid(
      dismissRequest({ fields: [{ id: "note", kind: "text", label: "Note", whenOption: ["missing"] }] }),
      {},
    );
    expectInvalid(
      dismissRequest({ fields: [{ id: "note", kind: "text", label: "Note", whenOption: ["dismiss", "dismiss"] }] }),
      {},
    );
    expectInvalid(dismissRequest({ fields: [{ id: "note", kind: "text", label: "Note", whenOption: [] }] }), {});
  });

  test("scope is present exactly for authorise and observes its bounds", () => {
    expect(validateDecisionRequest(requestForEffect("authorise"), { refs: ALL_REFS }).valid).toBe(true);

    const missing = requestForEffect("authorise");
    delete missing.options[0].scope;
    expectInvalid(missing);

    expectInvalid(
      dismissRequest({
        options: [
          {
            id: "dismiss",
            label: "Dismiss",
            effect: "dismiss",
            scope: { paths: ["x"], summary: "not allowed" },
          },
        ],
      }),
      {},
    );

    const noPaths = requestForEffect("authorise");
    noPaths.options[0].scope.paths = [];
    expectInvalid(noPaths);
    const tooManyPaths = requestForEffect("authorise");
    tooManyPaths.options[0].scope.paths = Array.from({ length: 33 }, (_, index) => `p${index}`);
    expectInvalid(tooManyPaths);
    const longSummary = requestForEffect("authorise");
    longSummary.options[0].scope.summary = "x".repeat(501);
    expectInvalid(longSummary);
    const absolutePath = requestForEffect("authorise");
    absolutePath.options[0].scope.paths = ["/etc/passwd"];
    expectInvalid(absolutePath);
    const traversalPath = requestForEffect("authorise");
    traversalPath.options[0].scope.paths = ["event-runtime/../outside"];
    expectInvalid(traversalPath);
  });

  test("every effect requires the refs declared in §3", () => {
    const requirements = {
      authorise: ["issue", "repo", "runId"],
      send_to_triage: ["issue"],
      answer: ["issue"],
      requeue: ["eventSource", "eventId"],
      approve_proposal: ["proposalId"],
      reject_proposal: ["proposalId"],
      dismiss: [],
    };

    for (const [effect, requiredRefs] of Object.entries(requirements)) {
      const request = requestForEffect(effect);
      expect(validateDecisionRequest(request, { refs: ALL_REFS }).valid).toBe(true);
      for (const ref of requiredRefs) {
        const refs = { ...ALL_REFS };
        delete refs[ref];
        expectInvalid(request, refs);
      }
    }
  });

  test("reject_proposal requires an applicable required text field", () => {
    expect(validateDecisionRequest(requestForEffect("reject_proposal"), { refs: ALL_REFS }).valid).toBe(true);

    const absent = requestForEffect("reject_proposal");
    absent.fields = [];
    expectInvalid(absent);

    const optional = requestForEffect("reject_proposal");
    optional.fields[0].required = false;
    expectInvalid(optional);

    const wrongKind = requestForEffect("reject_proposal");
    wrongKind.fields[0] = { id: "reason", kind: "confirm", label: "Reason", required: true };
    expectInvalid(wrongKind);

    const gatedElsewhere = requestForEffect("reject_proposal");
    gatedElsewhere.options.push({ id: "other", label: "Other", effect: "dismiss" });
    gatedElsewhere.fields[0].whenOption = ["other"];
    expectInvalid(gatedElsewhere);
  });

  test("enforces field count, ids, kind-specific keys, choices, and numeric relations", () => {
    const sixFields = Array.from({ length: 6 }, (_, index) => ({
      id: `f${index}`,
      kind: "text",
      label: `Field ${index}`,
    }));
    expect(validateDecisionRequest(dismissRequest({ fields: sixFields }), { refs: {} }).valid).toBe(true);
    expectInvalid(dismissRequest({ fields: [...sixFields, { id: "f6", kind: "text", label: "Seven" }] }), {});
    expectInvalid(dismissRequest({ fields: [sixFields[0], { ...sixFields[0] }] }), {});
    expectInvalid(dismissRequest({ fields: [{ id: "Bad", kind: "text", label: "Bad" }] }), {});
    expectInvalid(dismissRequest({ fields: [{ id: "x", kind: "unknown", label: "Bad" }] }), {});
    expectInvalid(dismissRequest({ fields: [{ id: "x", kind: "confirm", label: "Bad", maxLength: 2 }] }), {});
    expectInvalid(dismissRequest({ fields: [{ id: "x", kind: "text", label: "Bad", maxLength: 8193 }] }), {});
    expectInvalid(
      dismissRequest({ fields: [{ id: "x", kind: "text", label: "Bad", placeholder: "p".repeat(281) }] }),
      {},
    );
    expectInvalid(dismissRequest({ fields: [{ id: "x", kind: "number", label: "Bad", choices: [] }] }), {});
    expectInvalid(dismissRequest({ fields: [{ id: "x", kind: "single-choice", label: "No choices" }] }), {});

    expect(
      validateDecisionRequest(
        dismissRequest({
          fields: [
            {
              id: "pick",
              kind: "single-choice",
              label: "Pick",
              choices: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
              ],
            },
          ],
        }),
        { refs: {} },
      ).valid,
    ).toBe(true);
    expectInvalid(
      dismissRequest({
        fields: [{ id: "pick", kind: "single-choice", label: "Pick", choices: [{ id: "a", label: "A" }] }],
      }),
      {},
    );
    expectInvalid(
      dismissRequest({
        fields: [
          {
            id: "pick",
            kind: "multi-choice",
            label: "Pick",
            choices: [
              { id: "a", label: "A" },
              { id: "a", label: "Again" },
            ],
          },
        ],
      }),
      {},
    );
    expectInvalid(
      dismissRequest({
        fields: [
          {
            id: "pick",
            kind: "multi-choice",
            label: "Pick",
            choices: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
            minItems: 2,
            maxItems: 1,
          },
        ],
      }),
      {},
    );
    expectInvalid(
      dismissRequest({
        fields: [{ id: "count", kind: "number", label: "Count", minimum: 2, maximum: 1 }],
      }),
      {},
    );
  });
});

const RESPONSE_REQUEST = dismissRequest({
  options: [
    { id: "save", label: "Save", effect: "dismiss" },
    { id: "other", label: "Other", effect: "dismiss" },
  ],
  fields: [
    { id: "note", kind: "text", label: "Note", required: true, maxLength: 3 },
    {
      id: "single",
      kind: "single-choice",
      label: "Single",
      required: true,
      choices: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
    {
      id: "multi",
      kind: "multi-choice",
      label: "Multi",
      required: true,
      choices: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      minItems: 1,
      maxItems: 2,
    },
    { id: "confirm", kind: "confirm", label: "Confirm", required: true },
    {
      id: "count",
      kind: "number",
      label: "Count",
      required: true,
      minimum: 1,
      maximum: 3,
      integer: true,
    },
    { id: "other_note", kind: "text", label: "Other note", whenOption: ["other"] },
  ],
});

function validResponse() {
  return {
    schemaVersion: "factory.decision-response/v1",
    requestHash: decisionRequestHash(RESPONSE_REQUEST),
    optionId: "save",
    fields: { note: "yes", single: "a", multi: ["a", "b"], confirm: true, count: 2 },
    decidedBy: "operator",
    decidedAt: "2026-08-16T12:41:07.000Z",
  };
}

function expectInvalidResponse(mutator) {
  const response = validResponse();
  mutator(response);
  const checked = validateDecisionResponse(response, RESPONSE_REQUEST);
  expect(checked.valid).toBe(false);
  expect(checked.errors.length).toBeGreaterThan(0);
}

describe("decisionRequestHash", () => {
  test("uses canonical JSON key ordering", () => {
    const reordered = { options: RESPONSE_REQUEST.options, question: RESPONSE_REQUEST.question, fields: RESPONSE_REQUEST.fields, schemaVersion: RESPONSE_REQUEST.schemaVersion };
    expect(decisionRequestHash(reordered)).toBe(decisionRequestHash(RESPONSE_REQUEST));
    expect(decisionRequestHash(RESPONSE_REQUEST)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("validateDecisionResponse", () => {
  test("accepts every widget kind when applicable values satisfy the request", () => {
    expect(validateDecisionResponse(validResponse(), RESPONSE_REQUEST)).toEqual({ valid: true, errors: [] });
  });

  test("a field gated on the chosen option applies; the same field is rejected for another option", () => {
    const other = validResponse();
    other.optionId = "other";
    other.fields.other_note = "shown for other";
    expect(validateDecisionResponse(other, RESPONSE_REQUEST)).toEqual({ valid: true, errors: [] });

    const otherMissingOptional = validResponse();
    otherMissingOptional.optionId = "other";
    expect(validateDecisionResponse(otherMissingOptional, RESPONSE_REQUEST).valid).toBe(true);
  });

  test("optional applicable fields may be omitted but must be well-typed when present", () => {
    const optionalRequest = dismissRequest({
      fields: [{ id: "n", kind: "number", label: "N", minimum: 0 }],
    });
    const omitted = {
      ...validResponse(),
      requestHash: decisionRequestHash(optionalRequest),
      optionId: "dismiss",
      fields: {},
    };
    expect(validateDecisionResponse(omitted, optionalRequest)).toEqual({ valid: true, errors: [] });
    const badType = { ...omitted, fields: { n: "1" } };
    expect(validateDecisionResponse(badType, optionalRequest).valid).toBe(false);
    const belowMin = { ...omitted, fields: { n: -1 } };
    expect(validateDecisionResponse(belowMin, optionalRequest).valid).toBe(false);
  });

  test("requires the exact request hash and a declared option", () => {
    expectInvalidResponse((response) => {
      response.requestHash = `sha256:${"0".repeat(64)}`;
    });
    expectInvalidResponse((response) => {
      response.optionId = "missing";
    });
  });

  test("requires applicable required fields and non-empty required values", () => {
    expectInvalidResponse((response) => {
      delete response.fields.note;
    });
    expectInvalidResponse((response) => {
      response.fields.note = "";
    });
    const defaultRequiredMulti = clone(RESPONSE_REQUEST);
    delete defaultRequiredMulti.fields[2].minItems;
    const emptyMulti = validResponse();
    emptyMulti.requestHash = decisionRequestHash(defaultRequiredMulti);
    emptyMulti.fields.multi = [];
    expect(validateDecisionResponse(emptyMulti, defaultRequiredMulti).valid).toBe(false);
    expectInvalidResponse((response) => {
      response.fields.confirm = false;
    });
  });

  test("validates text type and maxLength", () => {
    expectInvalidResponse((response) => {
      response.fields.note = 3;
    });
    expectInvalidResponse((response) => {
      response.fields.note = "long";
    });
  });

  test("validates single-choice type and membership", () => {
    expectInvalidResponse((response) => {
      response.fields.single = ["a"];
    });
    expectInvalidResponse((response) => {
      response.fields.single = "missing";
    });
  });

  test("validates multi-choice type, membership, uniqueness, minItems, and maxItems", () => {
    expectInvalidResponse((response) => {
      response.fields.multi = "a";
    });
    expectInvalidResponse((response) => {
      response.fields.multi = ["missing"];
    });
    expectInvalidResponse((response) => {
      response.fields.multi = ["a", "a"];
    });
    expectInvalidResponse((response) => {
      response.fields.multi = [];
    });
    expectInvalidResponse((response) => {
      response.fields.multi = ["a", "b", "c"];
    });
  });

  test("validates number type, minimum, maximum, and integer", () => {
    expectInvalidResponse((response) => {
      response.fields.count = "2";
    });
    expectInvalidResponse((response) => {
      response.fields.count = 0;
    });
    expectInvalidResponse((response) => {
      response.fields.count = 4;
    });
    expectInvalidResponse((response) => {
      response.fields.count = 1.5;
    });
  });

  test("rejects undeclared and option-inapplicable field keys", () => {
    expectInvalidResponse((response) => {
      response.fields.unknown = "x";
    });
    expectInvalidResponse((response) => {
      response.fields.other_note = "hidden";
    });
  });

  test("rejects unknown response properties, bad timestamps, and malformed requests", () => {
    expectInvalidResponse((response) => {
      response.extra = true;
    });
    expectInvalidResponse((response) => {
      response.decidedAt = "yesterday";
    });
    expectInvalidResponse((response) => {
      response.requestHash = "not-a-hash";
    });
    expectInvalidResponse((response) => {
      response.decidedBy = "";
    });
    const invalidRequest = clone(RESPONSE_REQUEST);
    invalidRequest.options = [];
    expect(validateDecisionResponse(validResponse(), invalidRequest).valid).toBe(false);

    const semanticallyInvalidRequest = clone(RESPONSE_REQUEST);
    delete semanticallyInvalidRequest.fields[1].choices;
    expect(() => validateDecisionResponse(validResponse(), semanticallyInvalidRequest)).not.toThrow();
    expect(validateDecisionResponse(validResponse(), semanticallyInvalidRequest).valid).toBe(false);
  });
});
