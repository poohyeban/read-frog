interface PriorityQueue<T> {
  push: (item: T, priority: number) => void
  peek: () => T | undefined
  pop: () => T | undefined
  size: () => number
  isEmpty: () => boolean
  clear: () => void
  removeWhere: (predicate: (value: T) => boolean) => void
}

export class BinaryHeapPQ<T> implements PriorityQueue<T> {
  private heap: { key: number; value: T; order: number }[] = []
  private positions = new Map<T, number>()
  private sequence = 0

  constructor(
    private readonly compare = (a: number, b: number) => a - b,
    private readonly indexed = false,
  ) {}

  private compareAt(a: number, b: number) {
    const x = this.heap[a]!,
      y = this.heap[b]!
    return this.compare(x.key, y.key) || x.order - y.order
  }
  private swap(a: number, b: number) {
    ;[this.heap[a], this.heap[b]] = [this.heap[b]!, this.heap[a]!]
    if (this.indexed) {
      this.positions.set(this.heap[a].value, a)
      this.positions.set(this.heap[b].value, b)
    }
  }
  /** Indexed updates/removal for scheduler heads; existing heap consumers retain their API. */
  set(value: T, key: number) {
    const index = this.positions.get(value)
    if (index === undefined) {
      this.push(value, key)
      return
    }
    this.heap[index]!.key = key
    this.heap[index]!.order = this.sequence++
    if (index > 0 && this.compareAt(index, Math.floor((index - 1) / 2)) < 0) this.heapifyUp(index)
    else this.heapifyDown(index)
  }
  remove(value: T): boolean {
    const index = this.positions.get(value)
    if (index === undefined) return false
    this.positions.delete(value)
    const last = this.heap.pop()!
    if (index < this.heap.length) {
      this.heap[index] = last
      this.positions.set(last.value, index)
      if (index > 0 && this.compareAt(index, Math.floor((index - 1) / 2)) < 0) this.heapifyUp(index)
      else this.heapifyDown(index)
    }
    return true
  }

  push(item: T, priority: number) {
    if (this.indexed && this.positions.has(item)) {
      this.set(item, priority)
      return
    }
    this.heap.push({ key: priority, value: item, order: this.sequence++ })
    if (this.indexed) this.positions.set(item, this.heap.length - 1)
    this.heapifyUp(this.heap.length - 1)
  }

  peek() {
    return this.heap[0]?.value
  }

  pop() {
    if (this.isEmpty()) return undefined

    const result = this.heap[0]!.value
    const last = this.heap.pop()
    if (this.indexed) this.positions.delete(result)

    if (this.heap.length > 0 && last) {
      this.heap[0] = last
      if (this.indexed) this.positions.set(last.value, 0)
      this.heapifyDown(0)
    }

    return result
  }

  size() {
    return this.heap.length
  }

  isEmpty() {
    return this.heap.length === 0
  }

  clear() {
    this.heap = []
    this.positions.clear()
  }

  /**
   * Remove every entry matching the predicate. Removal (rather than
   * mark-and-skip-on-pop) matters: schedule() derives its next timer delay
   * from peek(), so a cancelled head with a far-future priority would stall
   * dispatch of the live tasks behind it.
   */
  removeWhere(predicate: (value: T) => boolean) {
    const kept = this.heap.filter((entry) => !predicate(entry.value))
    if (kept.length === this.heap.length) return
    this.heap = kept
    if (this.indexed) {
      this.positions.clear()
      kept.forEach((entry, i) => this.positions.set(entry.value, i))
    }
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.heapifyDown(i)
    }
  }

  private heapifyUp(index: number) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)
      if (this.compareAt(parentIndex, index) <= 0) break

      this.swap(parentIndex, index)
      index = parentIndex
    }
  }

  private heapifyDown(index: number) {
    let currentIndex = index
    while (true) {
      let nextIndex = currentIndex
      const leftChild = 2 * currentIndex + 1
      const rightChild = 2 * currentIndex + 2

      if (leftChild < this.heap.length && this.compareAt(nextIndex, leftChild) > 0) {
        nextIndex = leftChild
      }

      if (rightChild < this.heap.length && this.compareAt(nextIndex, rightChild) > 0) {
        nextIndex = rightChild
      }

      if (nextIndex === currentIndex) break

      this.swap(currentIndex, nextIndex)
      currentIndex = nextIndex
    }
  }
}
