/**
 * Pure helpers for answering a pending Antigravity IDE interaction through
 * `HandleCascadeUserInteraction`. Kept free of I/O so the exact wire shapes can
 * be unit-tested.
 *
 * Wire facts (from the hub descriptor closure, exa.cortex_pb.*):
 *   RequestedInteraction.ask_question  -> AskQuestionInteractionSpec { questions: AskQuestionEntry[] }
 *   CascadeUserInteraction.ask_question -> AskQuestionInteraction { responses: AskQuestionEntry[], cancelled: bool }
 *   AskQuestionEntry { question, options: AskQuestionOption{id,text}[], is_multi_select,
 *                      selected_option_ids: string[], write_in_response, skipped }
 * i.e. the reply echoes every pending entry with the user's selection filled in.
 */

export interface PendingInteraction {
  stepIndex: number;
  step: any;
  ri: any;
}

/** Locate the newest step carrying a non-empty `requestedInteraction`. */
export function findPendingInteraction(steps: any[]): PendingInteraction | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const ri = steps[i]?.requestedInteraction;
    if (ri && Object.keys(ri).length > 0) {
      return { stepIndex: i, step: steps[i], ri };
    }
  }
  return undefined;
}

export interface InteractionVariant {
  kind: string;
  variant: Record<string, unknown>;
}

/**
 * Build the confirm/deny variant for every approval-style interaction.
 * Returns undefined when `ri` is not an approval-style interaction (the caller
 * decides whether it is askQuestion or unsupported). `confirm` must be an
 * explicit boolean — approval is never inferred.
 */
export function buildApprovalVariant(ri: any, confirm: boolean, scopeName: string): InteractionVariant | undefined {
  if (ri.runCommand) {
    const proposed = ri.runCommand.commandLine ?? ri.runCommand.proposedCommandLine ?? '';
    return {
      kind: 'run_command',
      variant: { runCommand: { confirm, proposedCommandLine: proposed, submittedCommandLine: proposed } },
    };
  }
  if (ri.readUrlContent) {
    return { kind: 'read_url_content', variant: { readUrlContent: { confirm } } };
  }
  if (ri.permission) {
    return {
      kind: `permission(${ri.permission.resource?.action ?? '?'}:${ri.permission.resource?.target ?? '?'})`,
      variant: { permission: { allow: confirm, scope: scopeName } },
    };
  }
  if (ri.filePermission) {
    return {
      kind: `file_permission(${ri.filePermission.absolutePathUri ?? '?'})`,
      variant: {
        filePermission: { allow: confirm, scope: scopeName, absolutePathUri: ri.filePermission.absolutePathUri ?? '' },
      },
    };
  }
  if (ri.approvalInteraction) {
    return { kind: 'approval_interaction', variant: { approvalInteraction: { confirm } } };
  }
  if (ri.mcp) {
    return { kind: 'mcp', variant: { mcp: { confirm } } };
  }
  if (ri.openBrowserUrl) {
    return { kind: 'open_browser_url', variant: { openBrowserUrl: { confirm } } };
  }
  return undefined;
}

/** One caller-supplied answer to one pending question. */
export interface AskQuestionAnswerInput {
  /** 0-based index into the pending questions; defaults to the answer's own position. */
  question_index?: number;
  /** Selected option ids (exact match against the pending options). */
  option_ids?: string[];
  /** Selected options by visible text (exact, then case-insensitive trimmed match). */
  option_texts?: string[];
  /** Free-form "write-in" reply. */
  write_in?: string;
  /** Explicitly skip this question. */
  skip?: boolean;
}

export interface AskQuestionReplyInput {
  answers?: AskQuestionAnswerInput[];
  /** Explicitly cancel the whole prompt. */
  cancel?: boolean;
  /** Generic approve/deny flag; for askQuestion only `false` (= cancel) is meaningful. */
  confirm?: boolean;
}

interface QuestionEntry {
  question: string;
  options: Array<{ id: string; text: string }>;
  isMultiSelect: boolean;
}

export interface AskQuestionSummaryEntry {
  question: string;
  selectedOptionIds: string[];
  selectedOptionTexts: string[];
  writeInResponse?: string;
  skipped: boolean;
}

export interface AskQuestionReply extends InteractionVariant {
  cancelled: boolean;
  summary: AskQuestionSummaryEntry[];
}

/** The pending questions live in `requestedInteraction.askQuestion.questions`; the step's own
 *  `askQuestion.questions` is the fallback should the spec arrive empty. */
export function extractPendingQuestions(pending: Pick<PendingInteraction, 'step' | 'ri'>): QuestionEntry[] {
  const raw: any[] = pending.ri?.askQuestion?.questions?.length
    ? pending.ri.askQuestion.questions
    : (pending.step?.askQuestion?.questions ?? []);
  return raw.map((q) => ({
    question: typeof q?.question === 'string' ? q.question : '',
    options: Array.isArray(q?.options)
      ? q.options.map((o: any) => ({ id: typeof o?.id === 'string' ? o.id : '', text: typeof o?.text === 'string' ? o.text : '' }))
      : [],
    isMultiSelect: q?.isMultiSelect === true,
  }));
}

function describeOptions(q: QuestionEntry): string {
  if (q.options.length === 0) return '(free-text question, no options; use write_in)';
  return q.options.map((o) => `${JSON.stringify(o.id)}=${JSON.stringify(o.text)}`).join(', ');
}

function resolveOptionText(q: QuestionEntry, text: string, qi: number): string {
  let hit = q.options.filter((o) => o.text === text);
  if (hit.length === 0) {
    const norm = text.trim().toLowerCase();
    hit = q.options.filter((o) => o.text.trim().toLowerCase() === norm);
  }
  if (hit.length === 0) {
    throw new Error(`Question #${qi} has no option with text ${JSON.stringify(text)}; options: ${describeOptions(q)}`);
  }
  if (hit.length > 1) {
    throw new Error(`Question #${qi}: option text ${JSON.stringify(text)} is ambiguous; use option_ids. Options: ${describeOptions(q)}`);
  }
  if (!hit[0].id) {
    throw new Error(`Question #${qi}: option ${JSON.stringify(text)} carries no id, cannot be selected programmatically.`);
  }
  return hit[0].id;
}

/**
 * Build the `askQuestion` reply for a pending question set. Never fabricates an
 * answer: an unaddressed question, an unknown option or a single-select question
 * with several picks is an error, not a guess.
 */
export function buildAskQuestionReply(questions: QuestionEntry[], input: AskQuestionReplyInput): AskQuestionReply {
  const answers = input.answers;
  const hasAnswers = Array.isArray(answers) && answers.length > 0;

  if (input.cancel === true && hasAnswers) {
    throw new Error('askQuestion: `cancel` and `answers` are mutually exclusive.');
  }
  if (input.cancel === true || (!hasAnswers && input.confirm === false)) {
    return {
      kind: 'ask_question(cancelled)',
      variant: { askQuestion: { cancelled: true } },
      cancelled: true,
      summary: [],
    };
  }
  if (!hasAnswers) {
    throw new Error(
      'askQuestion is pending: provide `answers` (option_ids / option_texts / write_in / skip per question), '
      + 'or `cancel: true` (or confirm=false) to cancel it. confirm=true alone does not answer a question.',
    );
  }
  if (questions.length === 0) {
    throw new Error('askQuestion is pending but the trajectory carries no questions to answer.');
  }

  const byIndex = new Map<number, AskQuestionAnswerInput>();
  answers!.forEach((a, pos) => {
    const qi = a.question_index ?? pos;
    if (!Number.isInteger(qi) || qi < 0 || qi >= questions.length) {
      throw new Error(`askQuestion: question_index ${qi} out of range (pending question count: ${questions.length}).`);
    }
    if (byIndex.has(qi)) throw new Error(`askQuestion: question #${qi} answered more than once.`);
    byIndex.set(qi, a);
  });

  const responses: Array<Record<string, unknown>> = [];
  const summary: AskQuestionSummaryEntry[] = [];
  questions.forEach((q, qi) => {
    const a = byIndex.get(qi);
    if (!a) {
      throw new Error(
        `askQuestion: question #${qi} (${JSON.stringify(q.question)}) has no answer; `
        + 'answer every question or pass skip=true for it. Options: ' + describeOptions(q),
      );
    }
    const base: Record<string, unknown> = {
      question: q.question,
      options: q.options.map((o) => ({ id: o.id, text: o.text })),
      isMultiSelect: q.isMultiSelect,
    };

    if (a.skip === true) {
      if ((a.option_ids?.length ?? 0) > 0 || (a.option_texts?.length ?? 0) > 0 || a.write_in) {
        throw new Error(`askQuestion: question #${qi} cannot be skipped and answered at the same time.`);
      }
      responses.push({ ...base, skipped: true });
      summary.push({ question: q.question, selectedOptionIds: [], selectedOptionTexts: [], skipped: true });
      return;
    }

    const ids: string[] = [];
    for (const id of a.option_ids ?? []) {
      if (!q.options.some((o) => o.id === id)) {
        throw new Error(`Question #${qi} has no option id ${JSON.stringify(id)}; options: ${describeOptions(q)}`);
      }
      if (!ids.includes(id)) ids.push(id);
    }
    for (const text of a.option_texts ?? []) {
      const id = resolveOptionText(q, text, qi);
      if (!ids.includes(id)) ids.push(id);
    }
    const writeIn = typeof a.write_in === 'string' && a.write_in.length > 0 ? a.write_in : undefined;

    if (ids.length === 0 && writeIn === undefined) {
      throw new Error(
        `askQuestion: question #${qi} needs option_ids/option_texts, write_in or skip=true. Options: ${describeOptions(q)}`,
      );
    }
    if (ids.length > 1 && !q.isMultiSelect) {
      throw new Error(`askQuestion: question #${qi} is single-select but ${ids.length} options were chosen.`);
    }

    responses.push({
      ...base,
      selectedOptionIds: ids,
      ...(writeIn !== undefined ? { writeInResponse: writeIn } : {}),
    });
    summary.push({
      question: q.question,
      selectedOptionIds: ids,
      selectedOptionTexts: ids.map((id) => q.options.find((o) => o.id === id)?.text ?? ''),
      ...(writeIn !== undefined ? { writeInResponse: writeIn } : {}),
      skipped: false,
    });
  });

  return {
    kind: 'ask_question',
    variant: { askQuestion: { responses, cancelled: false } },
    cancelled: false,
    summary,
  };
}
