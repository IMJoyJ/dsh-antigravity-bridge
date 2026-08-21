export interface AntigravityModelInfo {
  id: string;
  name: string;
  group: 'gemini' | 'non-gemini';
  aliases: string[];
  recommended: boolean;
  contextWindow: string;
  description: string;
}

export const ANTIGRAVITY_MODELS: AntigravityModelInfo[] = [
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    group: 'gemini',
    aliases: ['flash', '3.7-flash', 'gemini-flash', 'default'],
    recommended: true,
    contextWindow: '1M+ tokens',
    description: '【推荐默认】Gemini 配额组（充沛配额，适合高并发与大量子任务），速度极快，支持 1M+ 超长上下文与多模态分析，日常编码与工程分析首选。'
  },
  {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6',
    group: 'non-gemini',
    aliases: ['opus', 'opus-4.6', 'claude-opus'],
    recommended: false,
    contextWindow: '200k tokens',
    description: '非 Gemini 配额组（配额受限严格），强推理与深度代码能力，适合高难攻坚与复杂代码重构。'
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    group: 'non-gemini',
    aliases: ['sonnet', 'sonnet-4.6', 'claude-sonnet'],
    recommended: false,
    contextWindow: '200k tokens',
    description: '非 Gemini 配额组常规模型，综合能力与配额性价比均次于 Gemini 3.7 Flash。'
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    group: 'gemini',
    aliases: ['pro', '3.1-pro', 'gemini-pro'],
    recommended: false,
    contextWindow: '1M+ tokens',
    description: '通用知识问答与综合常识模型；编码能力弱于 3.7 Flash，不推荐作为主力编程任务模型。'
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B',
    group: 'non-gemini',
    aliases: ['gpt-oss', 'oss-120b', 'gpt120b'],
    recommended: false,
    contextWindow: '128k tokens',
    description: '非 Gemini 配额组开源模型通道。'
  }
];

export const DEFAULT_MODEL_ID = 'gemini-3.7-flash';

/**
 * Normalizes input model name or alias to canonical Antigravity model ID.
 */
export function normalizeModelName(input?: string): string {
  if (!input || typeof input !== 'string') {
    return DEFAULT_MODEL_ID;
  }

  const raw = input.trim().toLowerCase();

  for (const m of ANTIGRAVITY_MODELS) {
    if (m.id.toLowerCase() === raw) return m.id;
    if (m.aliases.some(alias => alias.toLowerCase() === raw)) return m.id;
  }

  // Fallback: if starts with gemini or claude or custom, pass through
  return raw;
}
