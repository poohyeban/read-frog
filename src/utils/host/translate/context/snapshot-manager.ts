import type { ContextScope, ContextSnapshot, ContextSource } from "./types"
import type { ContextRequirements } from "@/utils/prompts/translation-template"
import { getSourceDocumentTitle } from "@/utils/content/document-title"
import { getDocumentDescription } from "@/utils/content/metadata"
import { Sha256Fields } from "@/utils/hash"
import { logger } from "@/utils/logger"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { ContextCoordinator } from "../context-coordinator"
import { inspectSourceRegion, projectSourceRegion } from "../source-document"
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
  pendingValidation: boolean
  validate?: () => boolean
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
    validations: 0,
    validationNodes: 0,
    styleReads: 0,
    unchangedValidations: 0,
    semanticParses: 0,
    semanticInvalidations: 0,
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
        if (scope.root && !scope.root.isConnected) throw new TranslationCancelledError()
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
        if (entry) this.validateEntry(entry)
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
            pendingValidation: false,
          }
          this.entries.set(id, entry)
          const captured = entry
          const roots = scope.root ? [scope.root, ...scope.dependencies] : []
          // Metadata is an explicit dependency, never the rest of the feed.
          const globalMetadata =
            scope.type === "Document" || (scope.type === "Article" && !scope.collection)
          if (
            globalMetadata &&
            (requirements.description || requirements.title || requirements.summary) &&
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
                captured.pendingValidation = true
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
              let prepared: { value: ContextSnapshot; validate: () => boolean }
              try {
                prepared = await this.extract(
                  scope,
                  requirements,
                  lease.documentIdentity,
                  generation,
                )
              } finally {
                this.metrics.activeExtractions--
              }
              taskSignal.throwIfAborted()
              this.invalidation.flush()
              if (scope.root && !scope.root.isConnected) throw new TranslationCancelledError()
              if (
                this.entries.get(id) !== captured ||
                generation !== captured.generation ||
                (captured.pendingValidation && !prepared.validate())
              ) {
                captured.generation++
                throw new ContextStaleError()
              }
              const { value } = prepared
              captured.validate = prepared.validate
              captured.pendingValidation = false
              const stable =
                captured.snapshot?.identity === value.identity ? captured.snapshot : value
              if (captured.snapshot !== stable) this.metrics.rebuilds++
              captured.snapshot = stable
              captured.dirty = false
              captured.preparedAt = Date.now()
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
  private validateEntry(entry: Entry): void {
    if (!entry.pendingValidation || !entry.validate || entry.dirty) return
    entry.pendingValidation = false
    if (!entry.validate()) {
      entry.dirty = true
      entry.generation++
      this.metrics.semanticInvalidations++
    } else this.metrics.unchangedValidations++
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
  ): Promise<{ value: ContextSnapshot; validate: () => boolean }> {
    const checks: Array<() => boolean> = []
    const rootReference = scope.root && new WeakRef(scope.root)
    const docReference = new WeakRef(scope.document)
    const descriptor = (value: ContextScope) =>
      Sha256Fields(
        value.type,
        String(value.collection),
        value.locator,
        ...value.dependencies.map(scopeRootIdentity),
      )
    const capturedDescriptor = descriptor(scope)
    const scopeKind =
      scope.type === "Document"
        ? "document"
        : scope.type === "Independent"
          ? "independent"
          : scope.type === "Selection"
            ? "selection"
            : undefined
    if (rootReference)
      checks.push(() => {
        const source = rootReference.deref()
        return (
          !!source?.isConnected &&
          descriptor(resolveContextScope({ source, kind: scopeKind })) === capturedDescriptor
        )
      })
    const captureProjection = (
      source: Element | Document | ShadowRoot,
      limit: number,
      nodes: number,
      semantics?: { render: (doc: Document) => string; expected?: string },
    ) => {
      const options = { maxCharacters: limit, maxNodes: nodes, sanitize: true }
      const projection = projectSourceRegion(source, options)
      this.metrics.styleReads += projection.styleReads
      const reference = new WeakRef(source)
      const fingerprint = projection.fingerprint
      let classes = projection.classes
      // Keep bounded serialized source, not live DOM. Unknown class changes are
      // checked with the actual parser on this detached source, without another
      // live DOM projection or guessing semantics from class names.
      const marker = "data-read-frog-context-class-probe"
      if (semantics)
        projection.classElements.forEach((node, index) => node.setAttribute(marker, String(index)))
      const serialized = semantics ? projection.document.documentElement.outerHTML : ""
      if (semantics) projection.classElements.forEach((node) => node.removeAttribute(marker))
      // Oversized markup uses conservative on-demand extraction. These markers
      // exist only in detached validation data and never reach a prompt/cache key.
      const html = serialized.length <= 64 * 1024 ? serialized : undefined
      checks.push(() => {
        const live = reference.deref()
        if (!live?.isConnected) return false
        const current = inspectSourceRegion(live, options)
        this.metrics.validationNodes += current.visitedNodes
        this.metrics.styleReads += current.styleReads
        if (current.fingerprint !== fingerprint) return false
        if (semantics && current.classes.some((value, index) => value !== classes[index])) {
          if (html === undefined) return false
          const copy = new DOMParser().parseFromString(html, "text/html")
          const elements = copy.querySelectorAll(`[${marker}]`)
          if (elements.length !== current.classes.length) return false
          const seen = new Set<number>()
          for (const element of elements) {
            const index = Number(element.getAttribute(marker))
            if (seen.has(index) || current.classes[index] === undefined) return false
            seen.add(index)
            const value = current.classes[index]
            if (value) element.setAttribute("class", value)
            else element.removeAttribute("class")
            element.removeAttribute(marker)
          }
          this.metrics.semanticParses++
          if (semantics.render(copy) !== semantics.expected) return false
          classes = current.classes
        }
        return true
      })
      return projection
    }
    const needTitle = requirements.title || requirements.summary
    const needBody = requirements.content || requirements.summary
    const root = scope.root
    const headingNode =
      needTitle && root instanceof Element
        ? findScopeElement(root, "h1,h2,h3,h4,h5,h6,[itemprop=headline]")
        : undefined
    if (needTitle && rootReference) {
      const headingReference = headingNode && new WeakRef(headingNode)
      checks.push(() => {
        const live = rootReference.deref()
        return (
          (live instanceof Element
            ? findScopeElement(live, "h1,h2,h3,h4,h5,h6,[itemprop=headline]")
            : undefined) === headingReference?.deref()
        )
      })
    }
    let heading = ""
    if (headingNode) {
      const projection = captureProjection(headingNode, 512, 256)
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
    if (needTitle && globalMetadata && !heading)
      checks.push(() => {
        const live = docReference.deref()
        return !!live && getSourceDocumentTitle(live).slice(0, 512) === webTitle
      })
    if (requirements.description && globalMetadata)
      checks.push(() => {
        const live = docReference.deref()
        return !!live && getDocumentDescription(live).slice(0, 512) === webDescription
      })
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
          const useParser =
            scope.type === "Document" || (scope.type === "Article" && !scope.collection)
          const url = scope.document.URL
          const render = (doc: Document) => {
            let html = doc.body.innerHTML
            if (useParser) {
              try {
                html = new Defuddle(doc, { url, useAsync: false }).parse().content || html
              } catch {
                logger.warn("Defuddle parsing failed, falling back to body text:")
                return (doc.body.textContent ?? "").slice(0, limit)
              }
            }
            return createMarkdownContent(prepareContextMarkdownSource(html, limit), url)
          }
          const semantics = { render: (doc: Document) => render(doc).slice(0, limit), expected: "" }
          const projection = captureProjection(source, limit, 2048, semantics)
          this.metrics.projections++
          this.metrics.visitedNodes += projection.visitedNodes
          truncated ||= projection.truncated
          const content = render(projection.document)
          truncated ||= content.length > limit
          semantics.expected = content.slice(0, limit)
          return semantics.expected
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
    return {
      validate: () => {
        this.metrics.validations++
        return checks.every((check) => check())
      },
      value: Object.freeze({
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
      }),
    }
  }
  isCurrent(snapshot: ContextSnapshot): boolean {
    this.invalidation.flush()
    return [...this.entries.values()].some((entry) => {
      if (entry.snapshot !== snapshot) return false
      this.validateEntry(entry)
      return !entry.dirty
    })
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
