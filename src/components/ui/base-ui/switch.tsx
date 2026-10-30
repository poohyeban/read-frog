"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import * as React from "react"
import { cn } from "@/utils/styles/utils"

// Shared Base UI switch: native CSS transitions, including reduced-motion support.

type SwitchSize = "sm" | "default"

type SwitchProps = SwitchPrimitive.Root.Props & { size?: SwitchSize }

/* `track`/`height` are the outer pill, `thumb` the resting circle, `gap` the inset
   around it. `height === thumb + 2 * gap` has to hold or the thumb stops being
   round. A thumb that floats inside the track reads as friendlier than one that
   fills it edge to edge, so the gap is ~10% of the track height. These are
   numbers rather than classes because the thumb's position and the drag bounds
   are computed from them. */
const SIZES = {
  default: { track: 32, height: 18.4, thumb: 14.4, gap: 2 },
  sm: { track: 24, height: 14, thumb: 11, gap: 1.5 },
} as const satisfies Record<
  SwitchSize,
  { track: number; height: number; thumb: number; gap: number }
>

/** Pointer slop, in px, before a press is reinterpreted as a drag. */
const DRAG_DEAD_ZONE = 2

/* The track carries a 1px transparent border that focus-visible and aria-invalid
   colour in. An absolutely positioned child is laid out against the padding box,
   i.e. inside that border, so every thumb x below is padding-box relative and has
   to give the border back. Miss this and the thumb sits 3px from the left edge but
   1px from the right. */
const TRACK_BORDER = 1

// Preserve pointer dragging and mid-transition pickup without loading an animation
// runtime for this short movement. Complex sliders/color pickers still use Motion.
function Switch({
  className,
  style,
  size = "default",
  checked,
  defaultChecked,
  disabled = false,
  readOnly = false,
  inputRef,
  onCheckedChange,
  ...props
}: SwitchProps) {
  const { track, height, thumb, gap } = SIZES[size]
  const inset = gap - TRACK_BORDER
  const travel = track - 2 * gap - thumb
  const pressExtend = thumb / 4
  /* Base UI already refuses to toggle a read-only switch on click or key; the
     drag and the hover/press shapes have to refuse too. */
  const locked = disabled || readOnly

  /* Base UI is always driven as controlled, from `isChecked`, so there is one copy
     of the state; the thumb's position is derived from it here. */
  const [uncontrolledChecked, setUncontrolledChecked] = React.useState(defaultChecked ?? false)
  const isChecked = checked ?? uncontrolledChecked

  /* Base UI's hidden checkbox. A drag toggles by clicking it, the same path a
     click on the switch takes, so every toggle arrives with real event details. */
  const inputElement = React.useRef<HTMLInputElement>(null)
  /* The caller's own `inputRef` still gets the element, handed on from ours. */
  React.useImperativeHandle(inputRef, () => inputElement.current as HTMLInputElement, [])

  const [hovered, setHovered] = React.useState(false)
  const [pressed, setPressed] = React.useState(false)

  /* The press in progress: where it started, and whether it has become a drag. */
  const gesture = React.useRef<{ clientX: number; originX: number; dragging: boolean } | null>(null)
  /* A drag ends in a pointerup, and the browser follows that with a click on the
     switch; this swallows it so the drag's own toggle is the only one. */
  const swallowNextClick = React.useRef(false)

  const extend = pressed ? pressExtend : hovered ? thumb / 8 : 0
  const thumbWidth = thumb + extend
  const thumbHeight = pressed ? thumb - pressExtend : thumb
  const restingX = isChecked ? inset + travel - extend : inset

  /* No mount animation: the first render already has the correct thumb position. */
  const thumbElement = React.useRef<HTMLSpanElement>(null)
  function getX() {
    const thumbNode = thumbElement.current
    if (!thumbNode) return restingX
    const transform = getComputedStyle(thumbNode).transform
    return transform === "none" ? restingX : new DOMMatrixReadOnly(transform).m41
  }
  function setX(value: number) {
    if (thumbElement.current) thumbElement.current.style.transform = `translateX(${value}px)`
  }
  function stopX() {
    const value = getX()
    if (thumbElement.current) thumbElement.current.style.transition = "none"
    setX(value)
  }

  /* The drag's right bound assumes the pressed (widest) thumb, since a drag is
     always pressed; its left bound is `inset`. */
  const dragMax = inset + travel - pressExtend

  /* Ends a press and reports whether it was a drag. A drag's thumb moves back to
     the resting position; the render that follows re-targets it if releasing
     moved that position (the thumb un-squashes, or the switch toggles). */
  function release(): boolean {
    const wasDragging = gesture.current?.dragging ?? false
    gesture.current = null
    setPressed(false)
    if (wasDragging) {
      if (thumbElement.current) thumbElement.current.style.transition = ""
      setX(restingX)
    }
    return wasDragging
  }

  /* Merged ahead of the caller's props, so the caller's handlers run first and can
     call `event.preventBaseUIHandler()` to skip these, as with any Base UI part. */
  /* oxlint-disable react/refs -- mergeProps only stores these handlers; they read refs when events fire, not during render. */
  const gestureProps = mergeProps<typeof SwitchPrimitive.Root>(
    {
      onPointerDown(event) {
        if (locked || (event.pointerType === "mouse" && event.button !== 0)) return
        setPressed(true)
        swallowNextClick.current = false
        gesture.current = { clientX: event.clientX, originX: getX(), dragging: false }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove(event) {
        const current = gesture.current
        if (!current) return
        const delta = event.clientX - current.clientX
        if (!current.dragging) {
          if (Math.abs(delta) < DRAG_DEAD_ZONE) return
          /* Pressing reshaped the thumb, so a transition toward the pressed resting
             position is still in flight and would keep overwriting the value set
             below. The finger wins: stop it, then re-anchor on wherever the thumb
             actually is, so tracking starts from the current pixel instead of
             snapping by the dead zone plus whatever the spring had already moved. */
          stopX()
          current.dragging = true
          // Keep the press anchor: the first move may be the only move before
          // pointerup (especially on touch). It must apply its displacement.
        }
        setX(Math.max(inset, Math.min(dragMax, current.originX + delta)))
      },
      onPointerUp() {
        if (!gesture.current) return
        const shouldBeOn = getX() > (inset + dragMax) / 2
        if (!release()) return
        if (shouldBeOn !== isChecked) inputElement.current?.click()
        swallowNextClick.current = true
      },
      onPointerCancel() {
        if (gesture.current) release()
      },
      onPointerEnter(event) {
        if (event.pointerType === "mouse" && !locked) setHovered(true)
      },
      onPointerLeave() {
        setHovered(false)
      },
      onClick(event) {
        /* Keyboard toggles arrive as clicks with `detail` 0 and are never swallowed. */
        if (!swallowNextClick.current || event.detail === 0) return
        swallowNextClick.current = false
        event.preventBaseUIHandler()
      },
    },
    props,
  )
  /* oxlint-enable react/refs */

  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 cursor-pointer touch-none items-center rounded-full border border-transparent transition-colors duration-100 outline-none select-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-readonly:cursor-default motion-reduce:transition-none dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-accent data-unchecked:bg-input dark:data-unchecked:bg-input/80 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...gestureProps}
      checked={isChecked}
      inputRef={inputElement}
      disabled={disabled}
      readOnly={readOnly}
      onCheckedChange={(next, eventDetails) => {
        onCheckedChange?.(next, eventDetails)
        if (!eventDetails.isCanceled) setUncontrolledChecked(next)
      }}
      /* The thumb geometry is computed from these two, so they are applied after
         the caller's style rather than being overridable by it. */
      style={(state) => ({
        ...(typeof style === "function" ? style(state) : style),
        width: track,
        height,
      })}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        render={
          <span
            ref={thumbElement}
            className="pointer-events-none absolute top-1/2 left-0 block rounded-full bg-white transition-[transform,width,height] duration-150 ease-out motion-reduce:transition-none"
            style={{
              transform: `translateX(${restingX}px)`,
              translate: "0 -50%",
              width: thumbWidth,
              height: thumbHeight,
            }}
          />
        }
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
