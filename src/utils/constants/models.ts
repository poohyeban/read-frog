import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai"
import type { JSONValue } from "ai"

type OpenAIReasoningEffort = Exclude<OpenAIResponsesProviderOptions["reasoningEffort"], undefined>

interface OpenAIGPT5ReasoningEffortPolicy {
  pattern: RegExp
  supportedValues: readonly OpenAIReasoningEffort[]
  recommendedValue?: OpenAIReasoningEffort
}

// Reviewed against provider catalogs and AI SDK docs on 2026-09-26.
// Keep existing IDs: persisted provider configs validate against these enums.
export const LLM_PROVIDER_MODELS = {
  openai: [
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-6-astra",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.6",
    "gpt-5.5",
    "gpt-5.4-pro",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.3-chat-latest",
    "gpt-5.2-pro",
    "gpt-5.2-chat-latest",
    "gpt-5.2",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex",
    "gpt-5.1-chat-latest",
    "gpt-5.1",
    "gpt-5-pro",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-codex",
    "gpt-5-chat-latest",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-mini",
  ],

  google: [
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.1-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-pro-latest",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-image-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-pro-preview",
    "gemini-3-pro-image-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-lite-preview-06-17",
    "gemini-2.0-flash",
  ],

  // Jalapeno Cloud addresses models by their catalog name verbatim — the id in an API
  // call is the same string shown on the models page. Narrowed to what suits translation:
  // the code-specialised (Kimi-K2.7-Code), vision-first (Qwen3-VL-*) and thinking-only
  // variants are left out, since neither buys anything here and both cost more per call.

  "openai-compatible": ["use-custom-model"],

  ollama: ["gemma4:e2b", "gemma4:e4b", "gemma3:4b", "llama3.2:3b"],
} as const

export const NON_API_TRANSLATE_PROVIDERS = ["google-translate"] as const
export const NON_API_TRANSLATE_PROVIDERS_MAP: Record<
  (typeof NON_API_TRANSLATE_PROVIDERS)[number],
  string
> = {
  "google-translate": "Google Translate",
}

export const PURE_TRANSLATE_PROVIDERS = ["google-translate"] as const

const OPENAI_GPT5_REASONING_EFFORT_POLICIES: OpenAIGPT5ReasoningEffortPolicy[] = [
  {
    pattern: /^(?:openai\/)?gpt-6-astra$/i,
    supportedValues: ["low", "medium", "high", "xhigh", "max"],
    recommendedValue: "low",
  },
  {
    pattern: /^(?:openai\/)?gpt-6-sol$/i,
    supportedValues: ["none", "low", "medium", "high", "xhigh", "max"],
    recommendedValue: "medium",
  },
  {
    pattern: /^(?:openai\/)?gpt-6-luna$/i,
    supportedValues: ["none", "low", "medium", "high", "xhigh", "max"],
    recommendedValue: "medium",
  },
  {
    pattern: /^(?:openai\/)?gpt-5\.6(?:-(?:luna|terra|sol))?$/i,
    supportedValues: ["none", "low", "medium", "high", "xhigh", "max"],
    recommendedValue: "none",
  },
  {
    pattern: /^gpt-5\.4-pro$/i,
    supportedValues: ["medium", "high", "xhigh"],
    recommendedValue: "medium",
  },
  {
    pattern: /^gpt-5\.2-pro$/i,
    supportedValues: ["medium", "high", "xhigh"],
    recommendedValue: "medium",
  },
  {
    pattern: /^gpt-5-pro$/i,
    supportedValues: ["high"],
    recommendedValue: "high",
  },
  {
    pattern: /^(?:gpt-5\.5|gpt-5\.4|gpt-5\.4-mini|gpt-5\.4-nano)$/i,
    supportedValues: ["none", "low", "medium", "high", "xhigh"],
    recommendedValue: "none",
  },
  {
    pattern: /^gpt-5\.2$/i,
    supportedValues: ["none", "low", "medium", "high", "xhigh"],
    recommendedValue: "none",
  },
  {
    pattern: /^(?:gpt-5\.1|gpt-5\.1-codex|gpt-5\.1-codex-mini)$/i,
    supportedValues: ["none", "low", "medium", "high"],
    recommendedValue: "none",
  },
  {
    pattern: /^(?:gpt-5|gpt-5-mini|gpt-5-nano|gpt-5-codex)$/i,
    supportedValues: ["minimal", "low", "medium", "high"],
    recommendedValue: "minimal",
  },
  {
    pattern:
      /^(?:gpt-5-chat-latest|gpt-5\.1-chat-latest|gpt-5\.2-chat-latest|gpt-5\.3-chat-latest)$/i,
    supportedValues: [],
  },
]

const OPENAI_GPT5_RECOMMENDED_MODEL_OPTIONS: Array<{
  pattern: RegExp
  options: Record<string, JSONValue>
}> = OPENAI_GPT5_REASONING_EFFORT_POLICIES.flatMap(({ pattern, recommendedValue }) => {
  if (recommendedValue === undefined) {
    return []
  }

  return [
    {
      pattern,
      options: { reasoningEffort: recommendedValue },
    },
  ]
})

export function getOpenAIGPT5ReasoningEffortPolicy(
  model: string,
): OpenAIGPT5ReasoningEffortPolicy | undefined {
  return OPENAI_GPT5_REASONING_EFFORT_POLICIES.find(({ pattern }) => pattern.test(model))
}

/**
 * Model options configuration.
 * Flat list design: first match wins, more specific patterns should be placed first.
 * Options are matched by model name, not by provider.
 */
export const LLM_MODEL_OPTIONS: Array<{
  pattern: RegExp
  options: Record<string, JSONValue>
}> = [
  // Gemini - specific patterns first
  // The versionless aliases track the newest generation, which uses thinkingLevel;
  // Pro and Flash 3.7/3.8 do not accept "minimal".
  // https://ai.google.dev/gemini-api/docs/thinking
  {
    pattern:
      /^(?:gemini-pro-latest|gemini-3(?:\.1)?-pro-preview(?:-customtools)?|gemini-3\.[78]-flash|gemini-flash-latest)$/i,
    options: { thinkingConfig: { thinkingLevel: "low", includeThoughts: false } },
  },
  {
    pattern: /^gemini-flash(?:-lite)?-latest$/i,
    options: { thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false } },
  },
  {
    pattern: /^gemini-3(?:\.\d+)?-.*?(?:-preview(?:-customtools)?)?$/i,
    options: { thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false } },
  },
  {
    pattern: /^gemini-2\.5-/i,
    options: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
  },
  {
    // Default for all other Gemini models
    pattern: /^gemini-/i,
    options: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
  },

  // Claude - use the lowest supported thinking setting.
  // https://platform.claude.com/docs/en/build-with-claude/thinking
  {
    pattern: /^claude-(?:opus-5-5|fable-5(?:-1)?)$/i,
    options: { effort: "low" },
  },
  {
    pattern: /^claude-sonnet-5-5$/i,
    options: { thinking: { type: "between_tools" } },
  },
  {
    pattern: /^claude-/i,
    options: { thinking: { type: "disabled" } },
  },

  // OpenAI reasoning models - use the lowest supported reasoning effort
  {
    pattern: /^(?:o1|o3|o4-mini)(?:-|$)/i,
    options: { reasoningEffort: "minimal" },
  },

  // OpenAI GPT-5 defaults use the lowest supported reasoning effort per model.
  // GPT-5 chat-latest variants are intentionally omitted because their docs do not advertise reasoning.effort.
  ...OPENAI_GPT5_RECOMMENDED_MODEL_OPTIONS,

  // Grok 4.3 can disable thinking; 4.5 and 4.6 cannot.
  {
    pattern: /^grok-4\.3$/i,
    options: { reasoningEffort: "none" },
  },
  {
    pattern: /^grok-4\.[56]$/i,
    options: { reasoningEffort: "low" },
  },
  {
    pattern: /^grok-4\.20-0309-reasoning$/i,
    options: { reasoningEffort: "low" },
  },

  // OpenAI-compatible reasoning models exposed by Groq/Cerebras and similar providers
  {
    pattern: /^(?:openai\/|accounts\/fireworks\/models\/)?gpt-oss-(?:20|120)b$/i,
    options: { reasoningEffort: "low" },
  },

  // Volcengine Doubao Seed models - disable thinking by default.
  // Keep the version suffix optional because non-Volcengine providers may expose the same model family without it.
  {
    pattern:
      /(?:^|\/)doubao-seed-(?:code-preview|1[.-](?:6(?:-(?:flash|vision))?|8)|2[.-]0-(?:lite|mini|pro|code-preview))(?:-\d{6})?$/i,
    options: { thinking: { type: "disabled" } },
  },

  // DeepSeek reasoning models - disable thinking by default
  {
    pattern: /(?:^|\/)deepseek-(?:reasoner|v4-(?:flash|pro))$/i,
    options: { thinking: { type: "disabled" } },
  },

  // Cohere reasoning models - disable thinking by default
  {
    pattern: /^command-a-reasoning(?:-.+)?$/i,
    options: { thinking: { type: "disabled" } },
  },

  // MiniMax reasoning-capable models - disable thinking/history by default.
  // Keep this provider-agnostic because recommendation matching is model-name based.
  {
    pattern: /(?:^|\/)minimax-m(?:2(?:[.-].*)?|3)$/i,
    options: { thinking: { type: "disabled" }, reasoningHistory: "disabled" },
  },

  // Fireworks reasoning-focused models - disable thinking/history by default
  {
    pattern: /^accounts\/fireworks\/models\/(?:kimi-k2(?:[a-z0-9.-].*)?|minimax-m2(?:[.-].*)?)$/i,
    options: { thinking: { type: "disabled" }, reasoningHistory: "disabled" },
  },

  // Kimi K2 models - disable thinking/history by default.
  // Keep instruct variants untouched; they should not receive Moonshot's `thinking` options.
  // Keep this broad because recommendation matching is model-name based rather than provider-scoped.
  {
    pattern: /(?:^|\/)kimi-k2(?!-instruct(?:[a-z0-9.-].*)?$)(?:[a-z0-9.-].*)?$/i,
    options: { thinking: { type: "disabled" }, reasoningHistory: "disabled" },
  },
  // Kimi K3 always reasons and does not accept the K2 thinking options.
  {
    pattern: /^kimi-k3$/i,
    options: { reasoningEffort: "low" },
  },

  // Namespaced Qwen3 models - disable reasoning by default.
  // Keep this before the broad Qwen rule so OpenAI-compatible Qwen3 ids can use reasoningEffort.
  {
    pattern: /(?:^|\/)qwen\/qwen3(?!.*[/.-](?:thinking|qwq)(?:[/.-]|$))[a-z0-9.-]*$/i,
    options: { reasoningEffort: "none" },
  },

  // Qwen models - disable thinking by default.
  // Keep this broad because recommendation matching is model-name based rather than provider-scoped.
  // Exclude Cerebras-style `qwen-3-*` ids; they do not support Alibaba's `enableThinking`.
  // Keep explicit thinking-only variants (for example `qwq-*` and `*-thinking`) untouched.
  {
    pattern: /(?:^|\/)qwen(?!-3-)(?!.*[/.-](?:thinking|qwq)(?:[/.-]|$)).*$/i,
    options: { enableThinking: false },
  },

  // GLM models - disable thinking (compatibility issues)
  {
    pattern: /(?:^|\/)GLM-/i,
    options: { thinking: { type: "disabled" } },
  },
]
