import type { EntityTable } from "dexie"
import { Dexie } from "dexie"
import AiSegmentationCache from "./tables/ai-segmentation-cache"
import ArticleSummaryCache from "./tables/article-summary-cache"
import Glossary from "./tables/glossary"
import GlossaryTerm from "./tables/glossary-term"
import TranslationCache from "./tables/translation-cache"
export default class AppDB extends Dexie {
  translationCache!: EntityTable<TranslationCache, "key">
  articleSummaryCache!: EntityTable<ArticleSummaryCache, "key">

  glossary!: EntityTable<Glossary, "id">
  glossaryTerm!: EntityTable<GlossaryTerm, "id">
  aiSegmentationCache!: EntityTable<AiSegmentationCache, "key">
  constructor() {
    super("ReadFrogLiteDB")
    this.version(1).stores({
      translationCache: "key,createdAt",
      articleSummaryCache: "key,createdAt",
    })
    this.version(2).stores({
      translationCache: "key,createdAt",
      articleSummaryCache: "key,createdAt",
      glossary: "id,createdAt,enabled",
      glossaryTerm: "id,glossaryId,&[glossaryId+targetLang+matchKey],enabled,updatedAt",
    })
    this.version(3).stores({
      translationCache: "key,createdAt",
      articleSummaryCache: "key,createdAt",
      glossary: "id,createdAt,enabled",
      glossaryTerm: "id,glossaryId,&[glossaryId+targetLang+matchKey],enabled,updatedAt",
      aiSegmentationCache: "key,createdAt",
    })
    this.aiSegmentationCache.mapToClass(AiSegmentationCache)
    this.glossary.mapToClass(Glossary)
    this.glossaryTerm.mapToClass(GlossaryTerm)
    this.translationCache.mapToClass(TranslationCache)
    this.articleSummaryCache.mapToClass(ArticleSummaryCache)
  }
}
