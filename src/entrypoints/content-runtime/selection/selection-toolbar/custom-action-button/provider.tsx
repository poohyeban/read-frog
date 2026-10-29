import type { ReactNode } from "react"
import type { SelectionSession } from "../atoms"
import type { SelectionPopoverActions } from "@/components/ui/selection-popover"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { customActionRequestAtom } from "@/components/custom-action/atoms"
import { CustomActionPanel } from "@/components/custom-action/custom-action-panel"
import { toastManager } from "@/components/ui/base-ui/toast"
import { SelectionPopover } from "@/components/ui/selection-popover"
import { createSelectionToolbarPrecheckError } from "@/components/ui/selection-popover/inline-error"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { findSelectionToolbarAction, getSelectionToolbarActions } from "@/utils/custom-actions"
import { onMessage } from "@/utils/message"
import { ShadowWrapperContext } from "@/utils/react-shadow-host/create-shadow-host"
import { normalizeSelectedText } from "../../utils"
import {
  contextAtom,
  isSelectionToolbarOpenAtom,
  selectionAtom,
  selectionSessionAtom,
} from "../atoms"
import { useSelectionOpenRequestResolver } from "../use-selection-open-request"
import { useSelectionShortcuts } from "../use-selection-shortcuts"

interface SelectionCustomActionPendingOpenRequest {
  actionId: string
  anchor?: { x: number; y: number }
  session: SelectionSession | null
}

interface SelectionCustomActionContextValue {
  openToolbarCustomAction: (actionId: string, triggerElement: HTMLElement | null) => void
}

const SelectionCustomActionContext = createContext<SelectionCustomActionContextValue | null>(null)

function useSelectionCustomActionContext() {
  const context = use(SelectionCustomActionContext)
  if (!context) {
    throw new Error(
      "Selection custom action triggers must be used within SelectionCustomActionProvider.",
    )
  }

  return context
}

export function useSelectionCustomActionPopover() {
  return useSelectionCustomActionContext()
}

export function SelectionCustomActionProvider({ children }: { children: ReactNode }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const selectionSession = useAtomValue(selectionSessionAtom)
  const selection = useAtomValue(selectionAtom)
  const context = useAtomValue(contextAtom)
  const selectionToolbarConfig = useAtomValue(configFieldsAtomMap.selectionToolbar)

  const [customActionRequest, setCustomActionRequest] = useAtom(customActionRequestAtom)
  const setIsSelectionToolbarOpen = useSetAtom(isSelectionToolbarOpenAtom)

  const shadowWrapper = use(ShadowWrapperContext)
  const pendingOpenRequestRef = useRef<SelectionCustomActionPendingOpenRequest | null>(null)
  const popoverActionsRef = useRef<SelectionPopoverActions | null>(null)
  const nextEphemeralSessionIdRef = useRef(0)
  const sessionKeyRef = useRef(0)
  const { resolveContextMenuOpenRequest, resolveShortcutOpenRequest } =
    useSelectionOpenRequestResolver(selectionSession)

  // Anchor application is owned by SelectionPopover.Root (via requestOpen) so
  // a pinned popover reused in place never moves.
  const commitOpenRequest = useCallback((request: SelectionCustomActionPendingOpenRequest) => {
    pendingOpenRequestRef.current = request
  }, [])

  const applyPendingSession = useCallback(
    (mode: "open" | "reuse") => {
      const pendingRequest = pendingOpenRequestRef.current
      const session = pendingRequest?.session ?? selectionSession
      const selectionText = session?.selectionSnapshot.text ?? ""
      const cleanSelection = normalizeSelectedText(selectionText)

      if (mode === "open") {
        sessionKeyRef.current += 1
      }

      setCustomActionRequest((previous) =>
        pendingRequest
          ? {
              actionId: pendingRequest.actionId,
              selectionText,
              cleanSelection,
              contextText: cleanSelection ? session?.contextSnapshot.text || cleanSelection : "",

              sessionKey: sessionKeyRef.current,
              // A reuse forces a rerun even when the retriggered request
              // resolves to an identical execution key.
              rerunNonce: mode === "reuse" ? (previous?.rerunNonce ?? 0) + 1 : 0,
            }
          : null,
      )
      setIsSelectionToolbarOpen(false)
      pendingOpenRequestRef.current = null
    },
    [selectionSession, setCustomActionRequest, setIsSelectionToolbarOpen],
  )

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        applyPendingSession("open")
      } else {
        setCustomActionRequest(null)
        if (pendingOpenRequestRef.current === null) {
          setAnchor(null)
        }
      }
    },
    [applyPendingSession, setCustomActionRequest],
  )

  // Pinned popovers are reused in place for a new selection or action: the
  // window keeps its position, size, and pin state while the action reruns.
  const handleReuseRequest = useCallback(() => {
    applyPendingSession("reuse")
  }, [applyPendingSession])

  const openActionRequest = useCallback(
    (request: SelectionCustomActionPendingOpenRequest) => {
      commitOpenRequest(request)
      popoverActionsRef.current?.requestOpen(request.anchor ?? null)
    },
    [commitOpenRequest],
  )

  const openToolbarCustomAction = useCallback(
    (actionId: string, triggerElement: HTMLElement | null) => {
      if (!triggerElement) {
        return
      }

      const rect = triggerElement.getBoundingClientRect()
      openActionRequest({
        actionId,
        anchor: { x: rect.left, y: rect.top },

        session:
          selectionSession ??
          (selection
            ? {
                id: --nextEphemeralSessionIdRef.current,
                createdAt: Date.now(),
                selectionSnapshot: selection,
                contextSnapshot: context ?? {
                  text: "",
                  paragraphs: [],
                },
              }
            : null),
      })
    },
    [context, openActionRequest, selection, selectionSession],
  )

  const openContextMenuCustomAction = useCallback(
    (actionId: string) => {
      const action = findSelectionToolbarAction(selectionToolbarConfig, actionId)
      if (!action || action.enabled === false) {
        const nextError = createSelectionToolbarPrecheckError("customAction", "actionUnavailable")

        toastManager.add({ type: "error", title: nextError.description })
        return
      }

      const request = resolveContextMenuOpenRequest()
      if (!request) {
        const nextError = createSelectionToolbarPrecheckError("customAction", "missingSelection")

        toastManager.add({ type: "error", title: nextError.description })
        return
      }

      openActionRequest({
        actionId: action.id,
        anchor: request.anchor,
        session: request.session,
      })
    },
    [openActionRequest, resolveContextMenuOpenRequest, selectionToolbarConfig],
  )

  // An action switched off has no key, whatever it was given.
  const actionShortcuts = useMemo(
    () =>
      Object.fromEntries(
        getSelectionToolbarActions(selectionToolbarConfig)
          .filter((action) => action.enabled !== false)
          .map((action) => [action.id, action.shortcut]),
      ),
    [selectionToolbarConfig],
  )

  useSelectionShortcuts(actionShortcuts, (actionId, session) => {
    const request = resolveShortcutOpenRequest(session)
    if (!request) {
      return false
    }
    openActionRequest({
      actionId,
      anchor: request.anchor,
      session: request.session,
    })
    return true
  })

  useEffect(() => {
    return onMessage("openSelectionCustomActionFromContextMenu", (message) => {
      openContextMenuCustomAction(message.data.actionId)
    })
  }, [openContextMenuCustomAction])

  const contextValue = useMemo<SelectionCustomActionContextValue>(
    () => ({
      openToolbarCustomAction,
    }),
    [openToolbarCustomAction],
  )

  return (
    <SelectionCustomActionContext value={contextValue}>
      {children}
      <SelectionPopover.Root
        open={customActionRequest !== null}
        onOpenChange={handleOpenChange}
        anchor={anchor}
        onAnchorChange={setAnchor}
        actionsRef={popoverActionsRef}
        onReuseRequest={handleReuseRequest}
      >
        <SelectionPopover.Content
          key={customActionRequest?.sessionKey ?? 0}
          container={shadowWrapper ?? document.body}
        >
          <CustomActionPanel />
        </SelectionPopover.Content>
      </SelectionPopover.Root>
    </SelectionCustomActionContext>
  )
}
