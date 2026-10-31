import { ResourceRejected } from "./resource-error"

interface Member {
  starts: number
  limit?: number
  parent?: Member
}
function root(member: Member): Member {
  if (member.parent) member.parent = root(member.parent)
  return member.parent ?? member
}
/** Ephemeral task state shared by batching, transport retries and singleton recovery. */
export class AttemptContext {
  private constructor(
    private readonly members: Map<string, Member>,
    readonly ids: readonly string[],
  ) {}
  static create(ids: readonly string[]) {
    const unique = [...new Set(ids)]
    if (!unique.length) throw new ResourceRejected("input-limit")
    return new AttemptContext(new Map(unique.map((id) => [id, { starts: 0 }])), unique)
  }
  subset(ids: readonly string[]) {
    const unique = [...new Set(ids)]
    if (!unique.length || unique.some((id) => !this.members.has(id)))
      throw new ResourceRejected("input-limit")
    return new AttemptContext(this.members, unique)
  }
  /** A late subscriber shares the already-consumed attempts of the physical task. */
  join(existing: AttemptContext) {
    for (const id of this.ids) {
      const old = existing.members.get(id)
      if (!old) throw new ResourceRejected("input-limit")
      const member = root(this.members.get(id)!),
        target = root(old)
      if (member === target) continue
      target.starts = Math.max(target.starts, member.starts)
      if (member.limit !== undefined)
        target.limit = Math.min(target.limit ?? member.limit, member.limit)
      member.parent = target
    }
  }
  canStart(limit: number) {
    return this.ids.every((id) => {
      const member = root(this.members.get(id)!)
      return member.starts < Math.min(member.limit ?? limit, limit)
    })
  }
  /** Called once at the real transport boundary, never for a cache lookup or a subscriber. */
  start(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10 || !this.canStart(limit))
      throw new ResourceRejected("attempts")
    for (const id of this.ids) {
      const member = root(this.members.get(id)!)
      member.limit = Math.min(member.limit ?? limit, limit)
      member.starts++
    }
  }
  get starts() {
    return Math.max(...this.ids.map((id) => root(this.members.get(id)!).starts))
  }
  get counts() {
    return this.ids.map((id) => root(this.members.get(id)!).starts)
  }
}
