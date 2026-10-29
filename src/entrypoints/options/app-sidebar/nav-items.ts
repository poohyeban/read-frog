export const ROUTE_DEFS = [
  { path: "/text-to-speech" },
  { path: "/transcription" },
  { path: "/video-subtitles/style" },
  { path: "/video-subtitles/auto-start" },
  { path: "/video-subtitles/subtitles-queue" },

  { path: "/video-subtitles" },
  { path: "/video-subtitles/prompts" },
  { path: "/video-subtitles/style/custom-css" },
  { path: "/custom-actions" },
  { path: "/input-translation" },
  { path: "/floating-button" },
  { path: "/advanced/glossary" },
  { path: "/advanced/glossary/:glossaryId" },
  { path: "/" },
  { path: "/preference" },
  { path: "/shortcuts" },
  { path: "/api-providers" },
  { path: "/page-translation" },

  { path: "/selection-toolbar" },
  { path: "/context-menu" },

  // Advanced is a sidebar GROUP with no page of its own; this path only exists
  // so links made before that change still land somewhere.

  // Detail pages drilled into from a `ConfigNavItem`. They own no sidebar entry — the
  // sidebar lists its links itself — but route exactly like any other page.

  { path: "/preference/extension-activation" },
  { path: "/page-translation/custom-css" },
  { path: "/page-translation/prompts" },
  { path: "/page-translation/translation-control" },
  { path: "/page-translation/translation-control/auto-translate-websites" },
  { path: "/page-translation/translation-control/never-auto-translate-websites" },
  { path: "/page-translation/translation-control/site-rules" },
  { path: "/page-translation/translation-queue" },
] as const
