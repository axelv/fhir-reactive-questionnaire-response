import { Signal } from "@lit-labs/signals";
import type {
  QuestionnaireItem,
  QuestionnaireResponseItem,
  AnswerValue,
  QuestionnaireItemType,
} from "./types.js";
import {
  getCalculatedExpression,
  getEnableWhenExpression,
  getAnswerOptionsToggleExpressions,
  answerValuesMatch,
  type ParsedExpression,
} from "./extensions.js";
import { evaluateFhirPath } from "./fhirpath-context.js";
import { evaluateEnableWhen } from "./enable-when.js";
import { ReactiveAnswerOption } from "./ReactiveAnswerOption.js";
import type { ReactiveQuestionnaireResponse } from "./ReactiveQuestionnaireResponse.js";
import compare from "./compare.js";

export class ReactiveResponseItem {
  readonly id: string | undefined;
  readonly linkId: string;
  readonly text: string;
  readonly type: QuestionnaireItemType;
  readonly items: ReactiveResponseItem[];
  readonly answerOptions: ReactiveAnswerOption[];

  #answer:
    | Signal.State<AnswerValue[] | null>
    | Signal.Computed<AnswerValue[] | null>;

  #enabled: Signal.Computed<boolean>;

  readonly calculatedExpression: ParsedExpression | null;
  readonly enableWhenExpression: ParsedExpression | null;

  readonly parent: ReactiveResponseItem | ReactiveQuestionnaireResponse;
  private readonly root: ReactiveQuestionnaireResponse;

  constructor(
    definition: QuestionnaireItem,
    responseItem: QuestionnaireResponseItem | undefined,
    parent: ReactiveResponseItem | ReactiveQuestionnaireResponse,
    root: ReactiveQuestionnaireResponse,
  ) {
    this.id = responseItem?.id;
    this.linkId = definition.linkId;
    this.text = definition.text ?? "";
    this.type = definition.type;
    this.parent = parent;
    this.root = root;

    this.calculatedExpression = getCalculatedExpression(definition.extension);
    this.enableWhenExpression = getEnableWhenExpression(definition.extension);

    const initialAnswers = responseItem?.answer
      ? responseItem.answer.map(stripAnswerValue)
      : [];

    this.#answer = new Signal.State<AnswerValue[]>(initialAnswers, {
      equals: compare,
    });

    this.items = hydrateChildren(
      definition.item ?? [],
      responseItem?.item ?? [],
      this,
      root,
    );

    this.answerOptions = buildAnswerOptions(definition, root);

    if (this.calculatedExpression) {
      const expression = this.calculatedExpression.expression;

      this.#answer = new Signal.Computed<AnswerValue[] | null>(() => {
        const results = evaluateFhirPath(expression, root);

        if (results.length === 0 || results[0] == null) return null;
        return results.map((v) => toAnswerValue(v, this.type)) as AnswerValue[];
      });
    }

    if (this.enableWhenExpression) {
      const expression = this.enableWhenExpression.expression;

      this.#enabled = new Signal.Computed<boolean>(() => {
        const results = evaluateFhirPath(expression, root);
        return results.length > 0 && results[0] === true;
      });
    } else if (definition.enableWhen && definition.enableWhen.length > 0) {
      const conditions = definition.enableWhen;
      const behavior = definition.enableBehavior ?? "all";

      this.#enabled = new Signal.Computed<boolean>(() => {
        return evaluateEnableWhen(conditions, behavior, (linkId) => {
          const items = root.getItems(linkId);
          if (items.length === 0) return null;
          return items[0].answer;
        });
      });
    } else {
      this.#enabled = new Signal.Computed<boolean>(() => true);
    }
  }

  get item(): ReactiveResponseItem[] {
    return this.items;
  }

  get enabled(): boolean {
    return this.#enabled.get();
  }

  get answer(): AnswerValue[] | null {
    return this.#answer.get();
  }

  setAnswer(value: AnswerValue[]): void {
    if (Signal.isState(this.#answer)) {
      (this.#answer as Signal.State<AnswerValue[] | null>).set(value);
    }
  }

  toFhir(): QuestionnaireResponseItem {
    const result: QuestionnaireResponseItem = { linkId: this.linkId };

    if (this.id) result.id = this.id;
    if (this.text) result.text = this.text;

    const answers = this.answer;
    if (answers && answers.length > 0) result.answer = answers;

    const childItems = this.items.map((child) => child.toFhir());
    if (childItems.length > 0) result.item = childItems;

    return result;
  }
}

/**
 * For each questionnaire definition item, find all matching response items
 * (same linkId). Repeating items produce multiple ReactiveResponseItems
 * from a single definition. If no response items match, create one empty instance.
 */
export function hydrateChildren(
  definitions: QuestionnaireItem[],
  responseItems: QuestionnaireResponseItem[],
  parent: ReactiveResponseItem | ReactiveQuestionnaireResponse,
  root: ReactiveQuestionnaireResponse,
): ReactiveResponseItem[] {
  const result: ReactiveResponseItem[] = [];
  // Track which response items have been consumed so order is preserved
  const consumed = new Set<number>();

  for (const def of definitions) {
    const matches: QuestionnaireResponseItem[] = [];
    for (let i = 0; i < responseItems.length; i++) {
      if (!consumed.has(i) && responseItems[i].linkId === def.linkId) {
        matches.push(responseItems[i]);
        consumed.add(i);
      }
    }

    if (matches.length === 0) {
      // No response data — create one empty instance from definition
      const item = new ReactiveResponseItem(def, undefined, parent, root);
      root.registerItem(item);
      result.push(item);
    } else {
      for (const ri of matches) {
        const item = new ReactiveResponseItem(def, ri, parent, root);
        root.registerItem(item);
        result.push(item);
      }
    }
  }

  return result;
}

function stripAnswerValue(answer: AnswerValue): AnswerValue {
  const result: AnswerValue = {};
  if (answer.valueBoolean !== undefined)
    result.valueBoolean = answer.valueBoolean;
  if (answer.valueDecimal !== undefined)
    result.valueDecimal = answer.valueDecimal;
  if (answer.valueInteger !== undefined)
    result.valueInteger = answer.valueInteger;
  if (answer.valueString !== undefined) result.valueString = answer.valueString;
  if (answer.valueCoding !== undefined) result.valueCoding = answer.valueCoding;
  if (answer.valueQuantity !== undefined)
    result.valueQuantity = answer.valueQuantity;
  if (answer.valueDate !== undefined) result.valueDate = answer.valueDate;
  if (answer.valueDateTime !== undefined)
    result.valueDateTime = answer.valueDateTime;
  if (answer.valueTime !== undefined) result.valueTime = answer.valueTime;
  if (answer.valueUri !== undefined) result.valueUri = answer.valueUri;
  return result;
}

function buildAnswerOptions(
  definition: QuestionnaireItem,
  root: ReactiveQuestionnaireResponse,
): ReactiveAnswerOption[] {
  if (!definition.answerOption || definition.answerOption.length === 0) return [];

  const toggleExpressions = getAnswerOptionsToggleExpressions(
    definition.extension,
  );

  // Pre-compute one Signal.Computed<boolean> per toggle expression
  const toggleSignals = toggleExpressions.map(
    (toggle) =>
      new Signal.Computed<boolean>(() => {
        const results = evaluateFhirPath(toggle.expression.expression, root);
        return results.length > 0 && results[0] === true;
      }),
  );

  // Shared signal for options not referenced by any toggle
  const alwaysEnabled = new Signal.Computed<boolean>(() => true);

  return definition.answerOption.map((opt) => {
    const value: AnswerValue = { ...opt };
    delete (value as Record<string, unknown>).initialSelected;

    // Find which toggle expression controls this option
    let signal = alwaysEnabled;
    for (let i = 0; i < toggleExpressions.length; i++) {
      const toggle = toggleExpressions[i];
      if (toggle.options.some((tv) => answerValuesMatch(tv, value))) {
        signal = toggleSignals[i];
        break;
      }
    }

    return new ReactiveAnswerOption(value, opt.initialSelected ?? false, signal);
  });
}

function toAnswerValue(
  raw: unknown,
  type: QuestionnaireItemType,
): AnswerValue | null {
  if (raw == null) return null;

  if (typeof raw === "number") {
    if (type === "integer") return { valueInteger: Math.round(raw) };
    return { valueDecimal: raw };
  }

  if (typeof raw === "string") {
    if (type === "date") return { valueDate: raw };
    if (type === "dateTime") return { valueDateTime: raw };
    return { valueString: raw };
  }

  if (typeof raw === "boolean") return { valueBoolean: raw };

  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if ("code" in obj)
      return { valueCoding: obj as AnswerValue["valueCoding"] };
    if ("value" in obj)
      return { valueQuantity: obj as AnswerValue["valueQuantity"] };
  }

  return null;
}
