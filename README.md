# fhir-reactive-questionnaire-response

A reactive data layer for FHIR [Questionnaire](https://hl7.org/fhir/questionnaire.html) + [QuestionnaireResponse](https://hl7.org/fhir/questionnaireresponse.html) with [SDC](http://hl7.org/fhir/uv/sdc/) support, built on [TC39 Signals](https://github.com/tc39/proposal-signals).

[**Live demo**](https://axelv.github.io/fhir-reactive-questionnaire-response/)

## Why

Rendering a FHIR Questionnaire means dealing with a web of inter-item dependencies: conditional visibility, calculated fields, dynamically enabled answer options. These dependencies form a **directed graph** that traditional form state management handles poorly — either re-evaluating everything on every change, or requiring manual dependency tracking that drifts from the spec.

This library takes a different approach. It reads the Questionnaire definition once and constructs a **signal graph** that mirrors the dependency structure. When a user changes an answer, only the signals that actually depend on it recompute. Everything else is untouched.

## How the signal graph works

Given a Questionnaire and an optional QuestionnaireResponse, the library constructs a tree of `ReactiveResponseItem` nodes. Each node contains **three reactive properties**, each backed by a Signal:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ReactiveResponseItem                                               │
│                                                                     │
│  answer ─── Signal.State (user-editable)                            │
│         └── Signal.Computed (when calculatedExpression is defined)   │
│                                                                     │
│  enabled ── Signal.Computed                                         │
│         └── evaluates enableWhen / enableWhenExpression              │
│         └── reads `answer` of referenced items → auto-subscribes    │
│                                                                     │
│  answerOptions[].enabled ── Signal.Computed (one per toggle group)  │
│         └── evaluates answerOptionsToggleExpression                  │
│         └── options in same group share one signal                   │
└─────────────────────────────────────────────────────────────────────┘
```

### `answer` — writable or computed

For regular items, `answer` is a `Signal.State` — set it and any dependents recompute:

```typescript
const [weight] = model.getItems("weight");
weight.answer = [{ valueDecimal: 70 }];
// any item with a calculatedExpression or enableWhen referencing "weight"
// recomputes automatically
```

When the Questionnaire defines a `calculatedExpression`, `answer` becomes a `Signal.Computed` instead. The FHIRPath expression is re-evaluated whenever any signal it reads during evaluation changes. Writes are silently ignored — the value is owned by the expression.

```typescript
const [bmi] = model.getItems("bmi");
bmi.answer; // recomputes from weight + height whenever either changes
bmi.answer = [{ valueDecimal: 99 }]; // no-op — calculated fields are read-only
```

### `enabled` — derived from dependencies

Each item's `enabled` property is a `Signal.Computed<boolean>` that derives from one of three sources (in priority order):

1. **`enableWhenExpression`** — a FHIRPath expression returning boolean. The expression runs against the full QuestionnaireResponse, so it auto-subscribes to any `answer` signal it touches during evaluation.

2. **`enableWhen`** — FHIR's built-in conditional logic. The computed reads the `answer` of each referenced item by linkId, establishing signal subscriptions.

3. **Neither** — always enabled (a computed returning `true`).

```typescript
const [details] = model.getItems("allergy-details");
details.enabled; // false

const [toggle] = model.getItems("has-allergies");
toggle.answer = [{ valueBoolean: true }];
details.enabled; // true — recomputed because the enableWhen references "has-allergies"
```

### `answerOptions[].enabled` — toggle groups share signals

For `choice` / `open-choice` items with `answerOption`, the library exposes a `ReactiveAnswerOption[]` array. Each option has an `enabled` getter backed by a signal.

The key optimization: the `answerOptionsToggleExpression` extension groups options together — all options controlled by the same expression share **one** `Signal.Computed`. This means a single FHIRPath evaluation toggles an entire group, not N individual evaluations.

```
answerOptionsToggleExpression (1 extension, 1 FHIRPath eval)
  ├── option: Aspirin ───┐
  ├── option: Ibuprofen ─┤── share the same Signal.Computed<boolean>
  └── expression: "...item.where(linkId='enable-nsaids').answer.value = true"

Acetaminophen ── not referenced by any toggle ── always enabled
```

```typescript
const [medication] = model.getItems("medication");

medication.answerOptions[0].enabled; // Acetaminophen: true (always)
medication.answerOptions[1].enabled; // Aspirin: false (toggle expression is false)
medication.answerOptions[2].enabled; // Ibuprofen: false (same signal as Aspirin)

const [toggle] = model.getItems("enable-nsaids");
toggle.answer = [{ valueBoolean: true }];

medication.answerOptions[1].enabled; // true — one FHIRPath eval flipped both
medication.answerOptions[2].enabled; // true
```

## What recomputes when

| User action | What recomputes | What doesn't |
|---|---|---|
| Set `weight` answer | `bmi` calculatedExpression | Unrelated items, `enabled` flags that don't reference `weight` |
| Set `has-allergies` to true | `allergy-details.enabled` | `weight`, `bmi`, other items' enabled flags |
| Set `enable-nsaids` to true | One toggle signal (shared by aspirin + ibuprofen) | Acetaminophen's enabled, unrelated items |

This is the granularity that signals provide for free. No diffing, no selectors, no manual subscriptions. The signal runtime tracks which computeds read which states during evaluation and only re-runs what's necessary.

## Usage

```bash
npm install fhir-reactive-questionnaire-response
```

```typescript
import {
  ReactiveQuestionnaireResponse,
  optionDisplay,
} from "fhir-reactive-questionnaire-response";

// Construct from FHIR Questionnaire + optional QuestionnaireResponse
const model = new ReactiveQuestionnaireResponse(questionnaire, response);

// Navigate items
const [item] = model.getItems("my-link-id");

// Read reactive properties (subscribe in your framework of choice)
item.answer;    // AnswerValue[] | null
item.enabled;   // boolean
item.answerOptions; // ReactiveAnswerOption[]

// Write answers
item.answer = [{ valueString: "hello" }];

// Serialize back to FHIR
const fhirResponse = model.toFhir();
```

### Framework integration

The signal graph is framework-agnostic — it uses [TC39 Signals](https://github.com/tc39/proposal-signals) (polyfilled via `@lit-labs/signals`). Any framework with signal support can subscribe to changes:

**Lit** — use `SignalWatcher`:
```typescript
import { SignalWatcher } from "@lit-labs/signals";

class MyForm extends SignalWatcher(LitElement) {
  render() {
    // accessing item.enabled / item.answer in render()
    // auto-subscribes — component re-renders on change
  }
}
```

**Preact/React/Solid** — the TC39 Signal proposal has adapters for each. Since the signals are standard, any compliant watcher works.

## Supported SDC extensions

| Extension | How it maps to signals |
|---|---|
| [`calculatedExpression`](http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-calculatedExpression) | `answer` becomes `Signal.Computed` — FHIRPath re-evaluated on dependency change |
| [`enableWhenExpression`](http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-enableWhenExpression) | `enabled` as `Signal.Computed` — FHIRPath boolean expression |
| [`answerOptionsToggleExpression`](http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-answerOptionsToggleExpression) | `answerOptions[].enabled` as shared `Signal.Computed` per toggle group |

Plus FHIR core `enableWhen` / `enableBehavior` (also reactive via signals).

## Development

```bash
npm install
npm test          # run tests
npm run demo      # launch demo at localhost:5173
npm run typecheck # type-check without emitting
npm run build     # build library to dist/
```

## License

MIT
