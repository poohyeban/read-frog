import type { ContextScope, ContextSnapshot, ContextSource } from "./types"
import type { ContextRequirements } from "@/utils/prompts/translation-template"
import { getSourceDocumentTitle } from "@/utils/content/document-title"
import { getDocumentDescription } from "@/utils/content/metadata"
import { Sha256Fields } from "@/utils/hash"
import { logger } from "@/utils/logger"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { ContextCoordinator } from "../context-coordinator"
import { projectSourceRegion } from "../source-document"
import { WEB_PAGE_CONTENT_CHAR_LIMIT } from "../webpage-content"
import { captureDocumentLease } from "./document-lifetime"
import { ContextInvalidationEngine } from "./invalidation"
import { prepareContextMarkdownSource } from "./markdown-source"
import { findScopeElement, resolveContextScope, scopeRootIdentity } from "./scope-resolver"

export class ContextStaleError extends Error {
  readonly code = "CONTEXT_STALE"
  readonly reason = "context-stale"
  constructor() {
    super("The source context changed while it was being prepared.")
    this.name = "ContextStaleError"
  }
}
export class ContextCapacityError extends Error {
  readonly code = "CONTEXT_CAPACITY"
  constructor() {
    super("Context preparation is busy. Retry after the current operation finishes.")
    this.name = "ContextCapacityError"
  }
}
interface Entry {
  readonly id: string
  readonly scopeId: string
  readonly descriptor: string
  readonly epoch: number
  generation: number
  active: number
  dirty: boolean
  preparedAt?: number
  snapshot?: ContextSnapshot
  release?: () => void
}
const requirementsKey = (value: ContextRequirements) =>
  `${+value.title}${+value.description}${+value.content}${+value.summary}`

export class ContextSnapshotManager {
  private readonly entries = new Map<string, Entry>()
  private entryEpoch = 0
  private readonly work: ContextCoordinator<ContextSnapshot>
  readonly invalidation = new ContextInvalidationEngine()
  readonly metrics = {
    resolutions: 0,
    hits: 0,
    rebuilds: 0,
    projections: 0,
    metadataProjections: 0,
    visitedNodes: 0,
    stalePreparations: 0,
    activeExtractions: 0,
    evictions: 0,
    resolveMs: 0,
    readMs: 0,
  }
  constructor(readonly capacity = 128) {
    this.work = new ContextCoordinator(capacity, 1000)
  }

  async read(
    input: ContextSource,
    requirements: ContextRequirements,
    ownerSignal?: AbortSignal,
  ): Promise<ContextSnapshot> {
    const started = performance.now()
    const doc = input.document ?? input.source?.ownerDocument ?? document
    const lease = captureDocumentLease(doc)
    const signal = ownerSignal ? AbortSignal.any([lease.signal, ownerSignal]) : lease.signal
    try {
      // Local snapshot recovery only; no Provider request exists in this layer.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted || !lease.isCurrent()) throw new TranslationCancelledError()
        this.invalidation.flush()
        const resolveStart = performance.now()
        const scope = resolveContextScope(input)
        this.metrics.resolveMs += performance.now() - resolveStart
        this.metrics.resolutions++
        const id = `${lease.routeIdentity}:${scope.id}:${requirementsKey(requirements)}:${Sha256Fields(scope.type === "Independent" || scope.type === "Selection" ? (input.text ?? "") : "")}`
        const descriptor = Sha256Fields(
          scope.type,
          String(scope.collection),
          scope.locator,
          ...scope.dependencies.map(scopeRootIdentity),
        )
        let entry = this.entries.get(id)
        if (entry && entry.descriptor !== descriptor) {
          this.drop(id)
          entry = undefined
        }
        if (entry?.snapshot && Date.now() - (entry.preparedAt ?? 0) > 5 * 60_000) {
          entry.dirty = true
          entry.generation++
        }
        if (entry && !entry.dirty && entry.snapshot) {
          this.touch(entry)
          this.metrics.hits++
          return entry.snapshot
        }
        if (!entry) {
          this.makeRoom()
          entry = {
            id,
            scopeId: scope.id,
            descriptor,
            epoch: ++this.entryEpoch,
            generation: 0,
            active: 0,
            dirty: true,
          }
          this.entries.set(id, entry)
          const captured = entry
          const roots = scope.root ? [scope.root, ...scope.dependencies] : []
          // Metadata is an explicit dependency, never the rest of the feed.
          const globalMetadata =
            scope.type === "Document" || (scope.type === "Article" && !scope.collection)
          if (
            globalMetadata &&
            (requirements.description ||
              ((requirements.title || requirements.summary) &&
                !(
                  scope.root instanceof Element &&
                  findScopeElement(scope.root, "h1,h2,h3,h4,h5,h6,[itemprop=headline]")
                ))) &&
            scope.document.head &&
            scope.root !== scope.document
          )
            roots.push(scope.document.head)
          const expired = () => this.drop(id)
          lease.signal.addEventListener("abort", expired, { once: true })
          captured.release = () => lease.signal.removeEventListener("abort", expired)
          if (roots.length)
            this.invalidation.register(
              id,
              roots,
              () => {
                captured.dirty = true
                captured.generation++
              },
              () => this.drop(id),
            )
        }
        const captured = entry
        const generation = captured.generation
        captured.active++
        try {
          const snapshot = await this.work.get(
            `${id}:${captured.epoch}:${generation}`,
            async (taskSignal) => {
              taskSignal.throwIfAborted()
              // Generations of one scope can overlap while a lazy parser load is
              // pending. Bound actual extraction, not only distinct cache roots.
              if (this.metrics.activeExtractions >= this.capacity) throw new ContextCapacityError()
              this.metrics.activeExtractions++
              let value: ContextSnapshot
              try {
                value = await this.extract(scope, requirements, lease.documentIdentity, generation)
              } finally {
                this.metrics.activeExtractions--
              }
              taskSignal.throwIfAborted()
              this.invalidation.flush()
              if (this.entries.get(id) !== captured || generation !== captured.generation)
                throw new ContextStaleError()
              const stable =
                captured.snapshot?.identity === value.identity ? captured.snapshot : value
              captured.snapshot = stable
              captured.dirty = false
              captured.preparedAt = Date.now()
              this.metrics.rebuilds++
              return stable
            },
            signal,
          )
          if (signal.aborted || !lease.isCurrent()) throw new TranslationCancelledError()
          return snapshot
        } catch (error) {
          if (!(error instanceof ContextStaleError)) throw error
          this.metrics.stalePreparations++
          if (attempt === 1) throw error
        } finally {
          captured.active--
        }
      }
      throw new ContextStaleError()
    } finally {
      this.metrics.readMs += performance.now() - started
    }
  }
  private touch(entry: Entry) {
    this.entries.delete(entry.id)
    this.entries.set(entry.id, entry)
  }
  private makeRoom() {
    while (this.entries.size >= this.capacity) {
      const candidate = [...this.entries.values()].find((entry) => entry.active === 0)
      if (!candidate) throw new ContextCapacityError()
      this.drop(candidate.id)
      this.metrics.evictions++
    }
  }
  private drop(id: string) {
    this.entries.get(id)?.release?.()
    this.entries.delete(id)
    this.invalidation.unregister(id)
  }
  private async extract(
    scope: ContextScope,
    requirements: ContextRequirements,
    documentIdentity: string,
    version: number,
  ): Promise<ContextSnapshot> {
    const needTitle = requirements.title || requirements.summary
    const needBody = requirements.content || requirements.summary
    const root = scope.root
    const headingNode =
      needTitle && root instanceof Element
        ? findScopeElement(root, "h1,h2,h3,h4,h5,h6,[itemprop=headline]")
        : undefined
    let heading = ""
    if (headingNode) {
      const projection = projectSourceRegion(headingNode, {
        maxCharacters: 512,
        maxNodes: 256,
        sanitize: true,
      })
      this.metrics.metadataProjections++
      this.metrics.visitedNodes += projection.visitedNodes
      heading = projection.document.body.textContent?.trim() ?? ""
    }
    const globalMetadata =
      scope.type === "Document" || (scope.type === "Article" && !scope.collection)
    const webTitle = needTitle
      ? heading || (globalMetadata ? getSourceDocumentTitle(scope.document).slice(0, 512) : "")
      : ""
    const webDescription =
      requirements.description && globalMetadata
        ? getDocumentDescription(scope.document).slice(0, 512)
        : ""
    let webContent = ""
    let truncated = false
    if (needBody) {
      if (
        scope.sourceText !== undefined &&
        (scope.type === "Independent" || scope.type === "Selection")
      ) {
        webContent = scope.sourceText.slice(0, WEB_PAGE_CONTENT_CHAR_LIMIT)
        truncated = scope.sourceText.length > webContent.length
      } else if (root) {
        const { default: Defuddle, createMarkdownContent } = await import("defuddle/full")
        const project = (source: Element | Document | ShadowRoot, limit: number) => {
          const projection = projectSourceRegion(source, {
            maxCharacters: limit,
            maxNodes: 2048,
            sanitize: true,
          })
          this.metrics.projections++
          this.metrics.visitedNodes += projection.visitedNodes
          truncated ||= projection.truncated
          let html = projection.document.body.innerHTML
          if (scope.type === "Document" || (scope.type === "Article" && !scope.collection)) {
            try {
              html =
                new Defuddle(projection.document, {
                  url: scope.document.URL,
                  useAsync: false,
                }).parse().content || html
            } catch {
              logger.warn("Defuddle parsing failed, falling back to body text:")
              return (projection.document.body.textContent ?? "").slice(0, limit)
            }
          }
          const content = createMarkdownContent(
            prepareContextMarkdownSource(html, limit),
            scope.document.URL,
          )
          truncated ||= content.length > limit
          return content.slice(0, limit)
        }
        const dependencyBudget = scope.dependencies.length
          ? Math.floor(WEB_PAGE_CONTENT_CHAR_LIMIT / 3)
          : 0
        webContent = project(root, WEB_PAGE_CONTENT_CHAR_LIMIT - dependencyBudget)
        if (scope.dependencies.length) {
          const parts = scope.dependencies.map((dependency) =>
            project(dependency, Math.floor(dependencyBudget / scope.dependencies.length)),
          )
          webContent += `\n\nExplicitly referenced source:\n${parts.join("\n\n")}`
          webContent = webContent.slice(0, WEB_PAGE_CONTENT_CHAR_LIMIT)
        }
      }
    }
    const fingerprint = Sha256Fields(webTitle, webDescription, webContent)
    const identity = Sha256Fields("context-snapshot-v2", requirementsKey(requirements), fingerprint)
    return Object.freeze({
      url: scope.document.defaultView?.location.href ?? scope.document.URL,
      webTitle,
      webDescription,
      webContent,
      identity,
      fingerprint,
      documentIdentity,
      scopeIdentity: scope.id,
      scopeType: scope.type,
      version,
      requirements: Object.freeze({ ...requirements }),
      provenance: Object.freeze({
        confidence: scope.confidence,
        collection: scope.collection,
        locator: scope.locator,
        truncated,
        createdAt: Date.now(),
        summary: "none",
      }),
    })
  }
  isCurrent(snapshot: ContextSnapshot): boolean {
    this.invalidation.flush()
    return [...this.entries.values()].some((entry) => !entry.dirty && entry.snapshot === snapshot)
  }
  invalidateAll(): void {
    for (const entry of this.entries.values()) {
      entry.dirty = true
      entry.generation++
    }
  }
  clear(): void {
    for (const entry of this.entries.values()) entry.release?.()
    this.entries.clear()
    this.invalidation.clear()
    this.work.clear()
  }
  inspect() {
    return {
      scopes: new Set([...this.entries.values()].map((entry) => entry.scopeId)).size,
      snapshots: this.entries.size,
      activePreparations: [...this.entries.values()].reduce((sum, entry) => sum + entry.active, 0),
      workEntries: this.work.size,
      capacity: this.capacity,
      ...this.metrics,
      invalidation: this.invalidation.inspect(),
    }
  }
}
