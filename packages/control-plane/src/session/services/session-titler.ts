import type Anthropic from "@anthropic-ai/sdk";

import type { Logger } from "../../logger";
import type { SpawnSource } from "../../types";
import type { SessionRow } from "../types";
import type { ServerMessage } from "../../types";

const MAX_TITLE_LENGTH = 60;
const TARGET_TITLE_LENGTH = 55;
const UNTITLED = "Untitled session";

interface SpawnSourceTitleMeta {
  prefix: string;
  instruction: string;
}

const DEFAULT_SPAWN_SOURCE_META: SpawnSourceTitleMeta = {
  prefix: "",
  instruction: "Output format: just the topic, no prefix.",
};

const SPAWN_SOURCE_TITLE_META: Record<SpawnSource, SpawnSourceTitleMeta> = {
  user: DEFAULT_SPAWN_SOURCE_META,
  agent: DEFAULT_SPAWN_SOURCE_META,
  automation: DEFAULT_SPAWN_SOURCE_META,
  "github-bot": {
    prefix: "GitHub: ",
    instruction:
      'Output format: "GitHub: <topic>". Replace any "PR #N" placeholder with a real topic. Comments become "GitHub: <ask>".',
  },
  "slack-bot": {
    prefix: "Slack: ",
    instruction: 'Output format: "Slack: <topic>".',
  },
  "linear-bot": {
    prefix: "Linear: ",
    instruction:
      'Output format: "Linear: <ticket-id> – <topic>" if a ticket ID like "ABC-123" is present in the prompt; otherwise "Linear: <topic>".',
  },
};

function getTitleMeta(spawnSource: SpawnSource | null | undefined): SpawnSourceTitleMeta {
  if (!spawnSource) return DEFAULT_SPAWN_SOURCE_META;
  return SPAWN_SOURCE_TITLE_META[spawnSource];
}

function sanitizePromptForTitle(prompt: string): string {
  let cleaned = prompt.replace(/```[\s\S]*?```/g, " ");
  cleaned = cleaned.replace(/https?:\/\/\S+/gi, " ");
  cleaned = cleaned.replace(/\*+([^*\n]+)\*+/g, "$1");
  cleaned = cleaned.replace(/`+([^`\n]+)`+/g, "$1");
  // Strip paired _emphasis_ but preserve snake_case identifiers.
  cleaned = cleaned.replace(/(^|\W)_+([^_\n]+?)_+(?=\W|$)/g, "$1$2");
  // Strip blockquote markers at line start; preserve x > y inline.
  cleaned = cleaned.replace(/^\s*>+\s?/gm, "");
  const firstLine = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  return firstLine.replace(/\s+/g, " ").trim();
}

function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.5) {
    return slice.slice(0, lastSpace) + " …";
  }
  return slice.slice(0, maxLength) + "…";
}

export interface TitlerClient {
  messages: {
    create: (
      params: Anthropic.Messages.MessageCreateParamsNonStreaming
    ) => Promise<Anthropic.Messages.Message>;
  };
}

const SET_TITLE_TOOL_NAME = "set_session_title";
const TITLER_MODEL = "claude-haiku-4-5";
const TITLER_MAX_OUTPUT_TOKENS = 50;

const SET_TITLE_TOOL: Anthropic.Messages.Tool = {
  name: SET_TITLE_TOOL_NAME,
  description:
    "Set the display title for a coding-agent session, shown in the left sidebar. Title must be short and human-readable.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: `A 3-6 word topic summary. Total length must be at most ${TARGET_TITLE_LENGTH} characters. No trailing punctuation, no quotes, no emoji.`,
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
};

const SYSTEM_MESSAGE = `You are naming a coding-agent session for display in a left-hand sidebar.
The user prompt is the first message they sent in this session.
Pick a short topic that summarizes what the session is about — what the user wants to do, or what they want changed.
Constraints:
- Total length must be at most ${TARGET_TITLE_LENGTH} characters (hard ceiling ${MAX_TITLE_LENGTH}).
- 3 to 6 words for the topic itself.
- Sentence case is fine.
- No trailing punctuation. No quotes. No emoji.
- Do not include the user's name or repository name unless the user mentioned it explicitly in the prompt.
You must respond by calling the ${SET_TITLE_TOOL_NAME} tool.`;

interface GenerateTitleArgs {
  client: TitlerClient | null;
  prompt: string;
  spawnSource: SpawnSource | null | undefined;
  log?: Logger;
}

function sanitizeModelTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;
  return collapsed.slice(0, MAX_TITLE_LENGTH);
}

export async function generateTitle(args: GenerateTitleArgs): Promise<string | null> {
  if (!args.client) return null;

  const userMessage = `${getTitleMeta(args.spawnSource).instruction}

User prompt:
${args.prompt}`;

  try {
    const response = await args.client.messages.create({
      model: TITLER_MODEL,
      max_tokens: TITLER_MAX_OUTPUT_TOKENS,
      temperature: 0,
      system: SYSTEM_MESSAGE,
      tools: [SET_TITLE_TOOL],
      tool_choice: {
        type: "tool",
        name: SET_TITLE_TOOL_NAME,
        disable_parallel_tool_use: true,
      },
      messages: [{ role: "user", content: userMessage }],
    });

    const toolBlock = response.content.find(
      (block): block is Anthropic.Messages.ToolUseBlock =>
        block.type === "tool_use" && block.name === SET_TITLE_TOOL_NAME
    );
    if (!toolBlock) return null;

    const input = toolBlock.input as { title?: unknown } | undefined;
    if (!input || typeof input.title !== "string") return null;

    const sanitized = sanitizeModelTitle(input.title);
    return sanitized.length > 0 ? sanitized : null;
  } catch (error) {
    args.log?.warn("auto_rename.titler_error", { error });
    return null;
  }
}

export function derivePromptTitle(
  prompt: string,
  spawnSource: SpawnSource | null | undefined
): string {
  const sanitized = sanitizePromptForTitle(prompt);
  const { prefix } = getTitleMeta(spawnSource);

  if (sanitized.length === 0) {
    return UNTITLED;
  }

  const budget = TARGET_TITLE_LENGTH - prefix.length;
  if (budget <= 0) {
    return UNTITLED;
  }

  const truncated = truncateAtWordBoundary(sanitized, budget);
  const candidate = prefix + truncated;

  if (candidate.length > MAX_TITLE_LENGTH) {
    return candidate.slice(0, MAX_TITLE_LENGTH - 1) + "…";
  }

  return candidate;
}

export interface TitleCommitDeps {
  repository: {
    updateSessionTitle: (sessionId: string, title: string, updatedAt: number) => void;
  };
  syncSessionIndexTitle: (publicSessionId: string, title: string) => void;
  broadcast: (message: ServerMessage) => void;
  now: () => number;
}

export function commitSessionTitle(
  deps: TitleCommitDeps,
  sessionId: string,
  publicSessionId: string,
  title: string
): void {
  deps.repository.updateSessionTitle(sessionId, title, deps.now());
  deps.syncSessionIndexTitle(publicSessionId, title);
  deps.broadcast({ type: "session_title", title });
}

export interface AutoRenameDeps extends TitleCommitDeps {
  repository: TitleCommitDeps["repository"] & {
    getSession: () => SessionRow | null;
    markTitleAutoRenameAttempted: (sessionId: string, attemptedAt: number) => void;
  };
  titler: (args: {
    prompt: string;
    spawnSource: SpawnSource | null | undefined;
  }) => Promise<string | null>;
  getPublicSessionId: (session: SessionRow) => string;
  log: Logger;
}

interface RunAutoRenameArgs {
  deps: AutoRenameDeps;
  prompt: string;
}

export async function runAutoRename({ deps, prompt }: RunAutoRenameArgs): Promise<void> {
  const session = deps.repository.getSession();
  if (!session) return;

  if (session.title_manually_set === 1) {
    deps.log.debug("auto_rename.skip", { reason: "title_manually_set", session_id: session.id });
    return;
  }
  if (session.title_auto_rename_attempted_at !== null) {
    deps.log.debug("auto_rename.skip", { reason: "already_attempted", session_id: session.id });
    return;
  }

  // Mark BEFORE the LLM call so a worker crash mid-call doesn't retry.
  deps.repository.markTitleAutoRenameAttempted(session.id, deps.now());

  const haikuTitle = await deps.titler({ prompt, spawnSource: session.spawn_source });

  const fresh = deps.repository.getSession();
  if (!fresh) return;
  if (fresh.title_manually_set === 1) {
    deps.log.info("auto_rename.skip_post_call", {
      reason: "title_manually_set_during_call",
      session_id: fresh.id,
    });
    return;
  }

  const existing = fresh.title?.trim() ?? "";
  let finalTitle: string;
  if (haikuTitle && haikuTitle.trim().length > 0) {
    finalTitle = haikuTitle;
  } else if (existing.length === 0) {
    finalTitle = derivePromptTitle(prompt, fresh.spawn_source);
  } else {
    deps.log.info("auto_rename.preserve_existing", {
      session_id: fresh.id,
      existing_title: existing,
    });
    return;
  }

  commitSessionTitle(deps, fresh.id, deps.getPublicSessionId(fresh), finalTitle);

  deps.log.info("auto_rename.applied", {
    session_id: fresh.id,
    used_haiku: haikuTitle !== null,
    final_title: finalTitle,
  });
}
