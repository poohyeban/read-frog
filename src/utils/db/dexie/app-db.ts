import type { EntityTable } from "dexie"
import { Dexie } from "dexie"
import ArticleSummaryCache from "./tables/article-summary-cache"
import BatchRequestRecord from "./tables/batch-request-record"
import TranslationCache from "./tables/translation-cache"
export default class AppDB extends Dexie {
  translationCache!: EntityTable<TranslationCache, "key">
  articleSummaryCache!: EntityTable<ArticleSummaryCache, "key">
  batchRequestRecord!: EntityTable<BatchRequestRecord, "key">
  constructor() {
    super("ReadFrogLiteDB")
    this.version(1).stores({
      translationCache: "key,createdAt",
      articleSummaryCache: "key,createdAt",
      batchRequestRecord: "key,createdAt,originalRequestCount,provider,model",
    })
    this.translationCache.mapToClass(TranslationCache)
    this.articleSummaryCache.mapToClass(ArticleSummaryCache)
    this.batchRequestRecord.mapToClass(BatchRequestRecord)
  }
}
