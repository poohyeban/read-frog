// @vitest-environment jsdom
import { describe, vi } from "vitest"

vi.mock("#imports", () => ({
  i18n: {
    t: (key: string) => key,
  },
}))

vi.mock("../../../components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}))

vi.mock("../page-translation-shortcut", () => ({
  PageTranslationShortcut: () => <section data-section="page-translation-shortcut" />,
}))

vi.mock("../translation-mode-shortcut", () => ({
  TranslationModeShortcut: () => <section data-section="translation-mode-shortcut" />,
}))

vi.mock("../selection-translation-shortcut", () => ({
  SelectionTranslationShortcut: () => <section data-section="selection-translation-shortcut" />,
}))

vi.mock("../selection-speak-shortcut", () => ({
  SelectionSpeakShortcut: () => <section data-section="selection-speak-shortcut" />,
}))

vi.mock("../action-shortcuts", () => ({
  ActionShortcuts: () => <section data-section="selection-action-shortcuts" />,
}))

vi.mock("../subtitles-toggle-shortcut", () => ({
  SubtitlesToggleShortcut: () => <section data-section="subtitles-toggle-shortcut" />,
}))

vi.mock("../node-translation-hotkey", () => ({
  NodeTranslationHotkey: () => <section data-section="node-translation-hotkey" />,
}))

vi.mock("../translation-hub-shortcut", () => ({
  TranslationHubShortcut: () => <section data-section="translation-hub-shortcut" />,
}))

describe("shortcuts page", () => {})
