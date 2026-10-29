export const ROUTE_DEFS = [
  { path: "/" },
  { path: "/preference" },
  { path: "/shortcuts" },
  { path: "/api-providers" },
  { path: "/page-translation" },
  { path: "/floating-button" },
  { path: "/selection-toolbar" },
  { path: "/context-menu" },
  { path: "/input-translation" },
  { path: "/tts" },
  // Advanced is a sidebar GROUP with no page of its own; this path only exists
  // so links made before that change still land somewhere.
  { path: "/advanced" },
  { path: "/help-and-community" },

  // Detail pages drilled into from a `ConfigNavItem`. They own no sidebar entry — the
  // sidebar lists its links itself — but route exactly like any other page.
  { path: "/advanced/glossary" },
  { path: "/advanced/glossary/:glossaryId" },
  { path: "/preference/extension-activation" },
  { path: "/page-translation/custom-css" },
  { path: "/page-translation/prompts" },
  { path: "/page-translation/translation-control" },
  { path: "/page-translation/translation-control/auto-translate-websites" },
  { path: "/page-translation/translation-control/never-auto-translate-websites" },
  { path: "/page-translation/translation-control/site-rules" },
  { path: "/page-translation/translation-queue" },
] as const
