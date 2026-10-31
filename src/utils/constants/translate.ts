export const DEFAULT_AUTO_TRANSLATE_SHORTCUT_KEY = "Alt+E"
export const DEFAULT_TRANSLATION_MODE_SHORTCUT_KEY = "Alt+Shift+M"
export const DEFAULT_SELECTION_TRANSLATION_SHORTCUT_KEY = "Alt+T"

export const MIN_PRELOAD_MARGIN = 0
export const MAX_PRELOAD_MARGIN = 10000
export const DEFAULT_PRELOAD_MARGIN = 1000

export const MIN_PRELOAD_THRESHOLD = 0
export const MAX_PRELOAD_THRESHOLD = 1
export const DEFAULT_PRELOAD_THRESHOLD = 0

// A single observed paragraph taller than this many viewports is split into
// its descendant paragraphs before observation, otherwise one flat giant
// container (e.g. docs.docker.com's 185k-px <article>) defeats viewport-lazy
// translation and enqueues the whole page at once (#1881).
export const GIANT_PARAGRAPH_SPLIT_VIEWPORT_MULTIPLIER = 3
// Floor for the viewport height used in the split cap, so tiny embedded
// frames don't shred normal paragraphs into fragments.
export const GIANT_PARAGRAPH_SPLIT_MIN_VIEWPORT_PX = 800
// Defensive bound on split recursion.
export const GIANT_PARAGRAPH_MAX_SPLIT_DEPTH = 10
// Safety valve on the stranded-text refusal: #1881's harm metric is
// units-enqueued-at-once, so bound the refusal by exactly that. Measured
// separation is two orders of magnitude — the containers the refusal exists
// for yield 11 (a Blogger post body), 77 (paulgraham.com/greatwork.html) and
// ~100 (a tc39 <li>) units, while the containers #1881 exists for yield 1.8k
// (a Wikipedia <body>), 4k (docs.docker.com's <main>) and 28k (tc39's <body>).
// Above this, keeping viewport gating beats rescuing a stray sentence.
export const GIANT_SPLIT_STRANDED_TEXT_MAX_UNITS = 128

export const MIN_CHARACTERS_PER_NODE = 0
export const MAX_CHARACTERS_PER_NODE = 1000
export const DEFAULT_MIN_CHARACTERS_PER_NODE = 0

export const MIN_WORDS_PER_NODE = 0
export const MAX_WORDS_PER_NODE = 100
export const DEFAULT_MIN_WORDS_PER_NODE = 0
