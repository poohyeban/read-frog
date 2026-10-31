declare module "@benchmark/source-srt" {
  export { buildSubtitlesSrtContent } from "@/utils/subtitles/srt"
}

declare module "@benchmark/source-segmentation" {
  export const cleanFragmentsForAi: typeof import("@/utils/subtitles/processor/ai-segmentation").cleanFragmentsForAi
  export const isSegmentationAligned: typeof import("@/utils/subtitles/processor/ai-segmentation").isSegmentationAligned
}
declare module "@benchmark/baseline-slots" {
  export class ExecutionSlots {
    constructor(maximum: number)
    readonly inFlight: number
  }
}
declare module "@benchmark/baseline-queue" {
  export class RequestQueue {
    constructor(options: Record<string, unknown>, priorityAgingMs: number)
    cancelByScope(scope: string): void
    enqueue<T>(
      task: (signal?: AbortSignal) => Promise<T>,
      at: number,
      key: string,
      scopes: string[],
      options: { priority: number; providerKey: string },
    ): Promise<T>
  }
}
