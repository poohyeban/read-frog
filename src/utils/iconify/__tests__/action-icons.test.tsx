import { Icon } from "@iconify/react/offline"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  createDictionaryDefinition,
  createImproveWritingDefinition,
  createSentenceAnalysisDefinition,
} from "@/utils/constants/custom-action-templates"
import { hasLocalIcon } from "../local-icons"

describe("persisted built-in Action icons", () => {
  it.each([
    ["dictionary", createDictionaryDefinition],
    ["sentence analysis", createSentenceAnalysisDefinition],
    ["improve writing", createImproveWritingDefinition],
  ] as const)("renders %s from the offline registry", (_name, createDefinition) => {
    const { icon } = createDefinition("local-provider")
    expect(hasLocalIcon(icon)).toBe(true)
    const markup = renderToStaticMarkup(<Icon icon={icon} />)
    expect(markup).toContain("<svg")
    expect(markup).toContain("<path")
    expect(markup).not.toContain("<img")
  })
})
