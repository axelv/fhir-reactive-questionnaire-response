import type { Questionnaire, QuestionnaireResponse } from "./types.js";
import {
  ReactiveResponseItem,
  hydrateChildren,
} from "./ReactiveResponseItem.js";

export class ReactiveQuestionnaireResponse {
  readonly resourceType = "QuestionnaireResponse" as const;
  readonly id: string | undefined;
  readonly status: string;
  readonly questionnaire: string | undefined;

  readonly items: ReactiveResponseItem[];
  readonly itemsByLinkId: Map<string, ReactiveResponseItem[]>;
  readonly itemById: Map<string, ReactiveResponseItem>;

  get item(): ReactiveResponseItem[] {
    return this.items;
  }

  constructor(questionnaire: Questionnaire, response?: QuestionnaireResponse) {
    this.id = response?.id;
    this.status = response?.status ?? "in-progress";
    this.questionnaire = response?.questionnaire ?? questionnaire.id;

    this.itemsByLinkId = new Map();
    this.itemById = new Map();

    this.items = hydrateChildren(
      questionnaire.item ?? [],
      response?.item ?? [],
      this,
      this,
    );
  }

  getItems(linkId: string): ReactiveResponseItem[] {
    return this.itemsByLinkId.get(linkId) ?? [];
  }

  getItemById(id: string): ReactiveResponseItem | undefined {
    return this.itemById.get(id);
  }

  registerItem(item: ReactiveResponseItem): void {
    const existing = this.itemsByLinkId.get(item.linkId);
    if (existing) {
      existing.push(item);
    } else {
      this.itemsByLinkId.set(item.linkId, [item]);
    }
    if (item.id) {
      this.itemById.set(item.id, item);
    }
  }

  toFhir(): QuestionnaireResponse {
    const result: QuestionnaireResponse = {
      resourceType: "QuestionnaireResponse",
      status: this.status,
    };

    if (this.id) result.id = this.id;
    if (this.questionnaire) result.questionnaire = this.questionnaire;

    const items = this.items.map((item) => item.toFhir());
    if (items.length > 0) result.item = items;

    return result;
  }

  forEachItem(fn: (item: ReactiveResponseItem) => void): void {
    const walk = (items: ReactiveResponseItem[]) => {
      for (const item of items) {
        fn(item);
        walk(item.items);
      }
    };
    walk(this.items);
  }
}
