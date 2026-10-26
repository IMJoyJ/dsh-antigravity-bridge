import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { fromBinary, toJson } from '@bufbuild/protobuf';
import type { DescMessage } from '@bufbuild/protobuf';
import { encodeGrpcWebFrame, grpcWebCall } from '../src/hub/transport.js';
import { getHubRegistry } from '../src/hub/registry.js';
import {
  buildApprovalVariant,
  buildAskQuestionReply,
  extractPendingQuestions,
  findPendingInteraction,
} from '../src/hub/interaction.js';
import { AntigravityService } from '../src/index.js';
import type { AntigravityConfig } from '../src/index.js';

const SERVICE = 'exa.language_server_pb.LanguageServerService';
const CASCADE = '11111111-2222-3333-4444-555555555555';
const TRAJ = 'traj-1';

const SINGLE_Q = {
  question: 'Pick a deck',
  options: [
    { id: 'a', text: 'Dragon' },
    { id: 'b', text: 'Spellbook' },
    { id: 'c', text: 'Tenpai' },
  ],
  isMultiSelect: false,
};
const MULTI_Q = {
  question: 'Pick tags',
  options: [
    { id: 'x', text: 'Fast' },
    { id: 'y', text: 'Safe' },
  ],
  isMultiSelect: true,
};
const FREE_Q = { question: 'Why?', options: [] as unknown[], isMultiSelect: false };

function askStep(questions: unknown[]): any {
  return { requestedInteraction: { askQuestion: { questions } }, askQuestion: { questions } };
}

function makeService(steps: any[], trajectoryId: string = TRAJ) {
  const ctx = new Context();
  const svc = new AntigravityService(ctx, {} as AntigravityConfig);
  const getCascadeTrajectory = vi.fn(async () => ({ trajectory: { trajectoryId, steps } }));
  const handleCascadeUserInteraction = vi.fn(async () => ({}));
  (svc as unknown as { getHubClient: () => Promise<unknown> }).getHubClient = async () => ({
    getCascadeTrajectory,
    handleCascadeUserInteraction,
  });
  return { svc, getCascadeTrajectory, handleCascadeUserInteraction };
}

describe('interaction helpers: findPendingInteraction', () => {
  it('returns the newest step with a non-empty requestedInteraction', () => {
    const steps = [
      { requestedInteraction: { runCommand: {} } },
      { requestedInteraction: {} },
      { requestedInteraction: { askQuestion: { questions: [SINGLE_Q] } } },
      {},
    ];
    const p = findPendingInteraction(steps);
    expect(p?.stepIndex).toBe(2);
    expect(Object.keys(p!.ri)).toEqual(['askQuestion']);
  });

  it('returns undefined when nothing is pending', () => {
    expect(findPendingInteraction([])).toBeUndefined();
    expect(findPendingInteraction([{}, { requestedInteraction: {} }])).toBeUndefined();
  });
});

describe('interaction helpers: extractPendingQuestions', () => {
  it('reads the spec from requestedInteraction.askQuestion', () => {
    const qs = extractPendingQuestions({ step: {}, ri: { askQuestion: { questions: [SINGLE_Q, MULTI_Q] } } });
    expect(qs).toHaveLength(2);
    expect(qs[0].options[1]).toEqual({ id: 'b', text: 'Spellbook' });
    expect(qs[1].isMultiSelect).toBe(true);
  });

  it('falls back to the step-level askQuestion when the spec is empty', () => {
    const qs = extractPendingQuestions({ step: { askQuestion: { questions: [SINGLE_Q] } }, ri: { askQuestion: {} } });
    expect(qs).toHaveLength(1);
    expect(qs[0].question).toBe('Pick a deck');
  });

  it('defaults missing JSON fields (proto3 omits empty/false)', () => {
    const qs = extractPendingQuestions({ step: {}, ri: { askQuestion: { questions: [{ question: 'Q' }] } } });
    expect(qs).toEqual([{ question: 'Q', options: [], isMultiSelect: false }]);
  });
});

describe('interaction helpers: buildAskQuestionReply', () => {
  const single = [extractPendingQuestions({ step: {}, ri: { askQuestion: { questions: [SINGLE_Q] } } })[0]];
  const both = extractPendingQuestions({ step: {}, ri: { askQuestion: { questions: [SINGLE_Q, MULTI_Q] } } });

  it('single-select by option id echoes the entry with selectedOptionIds', () => {
    const r = buildAskQuestionReply(single, { answers: [{ option_ids: ['b'] }] });
    expect(r.cancelled).toBe(false);
    expect(r.variant).toEqual({
      askQuestion: {
        cancelled: false,
        responses: [{ ...SINGLE_Q, selectedOptionIds: ['b'] }],
      },
    });
    expect(r.summary).toEqual([
      { question: 'Pick a deck', selectedOptionIds: ['b'], selectedOptionTexts: ['Spellbook'], skipped: false },
    ]);
  });

  it('resolves option_texts (exact, then trimmed case-insensitive)', () => {
    const exact = buildAskQuestionReply(single, { answers: [{ option_texts: ['Tenpai'] }] });
    expect((exact.variant.askQuestion as any).responses[0].selectedOptionIds).toEqual(['c']);
    const loose = buildAskQuestionReply(single, { answers: [{ option_texts: ['  dragon '] }] });
    expect((loose.variant.askQuestion as any).responses[0].selectedOptionIds).toEqual(['a']);
  });

  it('deduplicates repeated picks', () => {
    const r = buildAskQuestionReply(single, { answers: [{ option_ids: ['a'], option_texts: ['Dragon'] }] });
    expect((r.variant.askQuestion as any).responses[0].selectedOptionIds).toEqual(['a']);
  });

  it('multi-select accepts several ids', () => {
    const r = buildAskQuestionReply(both, {
      answers: [{ option_ids: ['a'] }, { option_ids: ['x', 'y'] }],
    });
    const responses = (r.variant.askQuestion as any).responses;
    expect(responses[0].selectedOptionIds).toEqual(['a']);
    expect(responses[1].selectedOptionIds).toEqual(['x', 'y']);
    expect(responses[1].isMultiSelect).toBe(true);
  });

  it('write-in only and write-in alongside an option', () => {
    const w = buildAskQuestionReply(single, { answers: [{ write_in: 'something else' }] });
    const e = (w.variant.askQuestion as any).responses[0];
    expect(e.writeInResponse).toBe('something else');
    expect(e.selectedOptionIds).toEqual([]);
    const both2 = buildAskQuestionReply(single, { answers: [{ option_ids: ['a'], write_in: 'note' }] });
    const e2 = (both2.variant.askQuestion as any).responses[0];
    expect(e2.selectedOptionIds).toEqual(['a']);
    expect(e2.writeInResponse).toBe('note');
  });

  it('free-text question (no options) is answerable by write_in', () => {
    const free = extractPendingQuestions({ step: {}, ri: { askQuestion: { questions: [FREE_Q] } } });
    const r = buildAskQuestionReply(free, { answers: [{ write_in: 'because' }] });
    expect((r.variant.askQuestion as any).responses[0].writeInResponse).toBe('because');
  });

  it('question_index addresses questions out of order', () => {
    const r = buildAskQuestionReply(both, {
      answers: [{ question_index: 1, option_ids: ['y'] }, { question_index: 0, option_ids: ['c'] }],
    });
    const responses = (r.variant.askQuestion as any).responses;
    expect(responses.map((x: any) => x.selectedOptionIds)).toEqual([['c'], ['y']]);
  });

  it('skip marks the entry skipped and nothing else', () => {
    const r = buildAskQuestionReply(single, { answers: [{ skip: true }] });
    const e = (r.variant.askQuestion as any).responses[0];
    expect(e.skipped).toBe(true);
    expect(e.selectedOptionIds).toBeUndefined();
    expect(r.summary[0].skipped).toBe(true);
  });

  it('cancel and confirm=false (without answers) produce a cancelled reply', () => {
    for (const input of [{ cancel: true }, { confirm: false }, { cancel: true, confirm: true }]) {
      const r = buildAskQuestionReply(single, input);
      expect(r.cancelled).toBe(true);
      expect(r.variant).toEqual({ askQuestion: { cancelled: true } });
    }
  });

  it('rejects: confirm=true / nothing at all does not answer', () => {
    expect(() => buildAskQuestionReply(single, { confirm: true })).toThrow(/does not answer a question/);
    expect(() => buildAskQuestionReply(single, {})).toThrow(/provide `answers`/);
    expect(() => buildAskQuestionReply(single, { answers: [] })).toThrow(/provide `answers`/);
  });

  it('rejects cancel together with answers', () => {
    expect(() => buildAskQuestionReply(single, { cancel: true, answers: [{ option_ids: ['a'] }] })).toThrow(/mutually exclusive/);
  });

  it('rejects unknown option id / text with the valid options listed', () => {
    expect(() => buildAskQuestionReply(single, { answers: [{ option_ids: ['zzz'] }] })).toThrow(/no option id "zzz".*"a"="Dragon"/);
    expect(() => buildAskQuestionReply(single, { answers: [{ option_texts: ['Nope'] }] })).toThrow(/no option with text "Nope"/);
  });

  it('rejects several picks on a single-select question', () => {
    expect(() => buildAskQuestionReply(single, { answers: [{ option_ids: ['a', 'b'] }] })).toThrow(/single-select/);
  });

  it('rejects empty answer, unanswered questions, bad / duplicate index, skip+answer', () => {
    expect(() => buildAskQuestionReply(single, { answers: [{}] })).toThrow(/needs option_ids/);
    expect(() => buildAskQuestionReply(both, { answers: [{ option_ids: ['a'] }] })).toThrow(/question #1.*no answer/);
    expect(() => buildAskQuestionReply(single, { answers: [{ question_index: 5, option_ids: ['a'] }] })).toThrow(/out of range/);
    expect(() => buildAskQuestionReply(single, { answers: [{ question_index: -1, option_ids: ['a'] }] })).toThrow(/out of range/);
    expect(() => buildAskQuestionReply(single, { answers: [{ question_index: 0, option_ids: ['a'] }, { question_index: 0, option_ids: ['b'] }] })).toThrow(/more than once/);
    expect(() => buildAskQuestionReply(single, { answers: [{ skip: true, option_ids: ['a'] }] })).toThrow(/skipped and answered/);
  });

  it('rejects answering when the trajectory carries no questions', () => {
    expect(() => buildAskQuestionReply([], { answers: [{ option_ids: ['a'] }] })).toThrow(/no questions/);
  });

  it('rejects an option that has no id when selected by text', () => {
    const qs = extractPendingQuestions({ step: {}, ri: { askQuestion: { questions: [{ question: 'Q', options: [{ text: 'T' }] }] } } });
    expect(() => buildAskQuestionReply(qs, { answers: [{ option_texts: ['T'] }] })).toThrow(/no id/);
  });

  it('rejects ambiguous option text', () => {
    const qs = extractPendingQuestions({
      step: {},
      ri: { askQuestion: { questions: [{ question: 'Q', options: [{ id: '1', text: 'Same' }, { id: '2', text: 'Same' }] }] } },
    });
    expect(() => buildAskQuestionReply(qs, { answers: [{ option_texts: ['Same'] }] })).toThrow(/ambiguous/);
  });
});

describe('interaction helpers: buildApprovalVariant (permission regression)', () => {
  it('permission / filePermission carry allow + scope exactly as before', () => {
    expect(buildApprovalVariant({ permission: { resource: { action: 'READ', target: 'x' } } }, true, 'PERMISSION_SCOPE_ONCE')).toEqual({
      kind: 'permission(READ:x)',
      variant: { permission: { allow: true, scope: 'PERMISSION_SCOPE_ONCE' } },
    });
    expect(buildApprovalVariant({ filePermission: { absolutePathUri: 'file:///d:/a' } }, false, 'PERMISSION_SCOPE_CONVERSATION')).toEqual({
      kind: 'file_permission(file:///d:/a)',
      variant: { filePermission: { allow: false, scope: 'PERMISSION_SCOPE_CONVERSATION', absolutePathUri: 'file:///d:/a' } },
    });
  });

  it('runCommand echoes the proposed command line; confirm-style variants carry confirm', () => {
    expect(buildApprovalVariant({ runCommand: { commandLine: 'ls' } }, true, 's')?.variant).toEqual({
      runCommand: { confirm: true, proposedCommandLine: 'ls', submittedCommandLine: 'ls' },
    });
    expect(buildApprovalVariant({ readUrlContent: {} }, false, 's')?.variant).toEqual({ readUrlContent: { confirm: false } });
    expect(buildApprovalVariant({ approvalInteraction: {} }, true, 's')?.variant).toEqual({ approvalInteraction: { confirm: true } });
    expect(buildApprovalVariant({ mcp: {} }, true, 's')?.variant).toEqual({ mcp: { confirm: true } });
    expect(buildApprovalVariant({ openBrowserUrl: {} }, true, 's')?.variant).toEqual({ openBrowserUrl: { confirm: true } });
  });

  it('returns undefined for non-approval variants (askQuestion, deploy)', () => {
    expect(buildApprovalVariant({ askQuestion: {} }, true, 's')).toBeUndefined();
    expect(buildApprovalVariant({ deploy: {} }, true, 's')).toBeUndefined();
  });
});

describe('AntigravityService.hubRespondApproval', () => {
  it('answers a pending askQuestion by option id (the reported failure case)', async () => {
    const { svc, handleCascadeUserInteraction } = makeService([{}, askStep([SINGLE_Q])]);
    const res: any = await svc.hubRespondApproval(CASCADE, undefined, undefined, { answers: [{ option_ids: ['a'] }] });
    expect(handleCascadeUserInteraction).toHaveBeenCalledTimes(1);
    expect(handleCascadeUserInteraction).toHaveBeenCalledWith(CASCADE, {
      trajectoryId: TRAJ,
      stepIndex: 1,
      askQuestion: { cancelled: false, responses: [{ ...SINGLE_Q, selectedOptionIds: ['a'] }] },
    });
    expect(res.answered).toBe('ask_question');
    expect(res.cancelled).toBe(false);
    expect(res.stepIndex).toBe(1);
    expect(res.answers[0].selectedOptionTexts).toEqual(['Dragon']);
  });

  it('answers multi-select + text + skip across several questions', async () => {
    const { svc, handleCascadeUserInteraction } = makeService([askStep([MULTI_Q, FREE_Q, SINGLE_Q])]);
    await svc.hubRespondApproval(CASCADE, undefined, undefined, {
      answers: [{ option_ids: ['x', 'y'] }, { write_in: 'because' }, { skip: true }],
    });
    const sent: any = (handleCascadeUserInteraction.mock.calls[0] as any[])[1];
    expect(sent.askQuestion.responses[0].selectedOptionIds).toEqual(['x', 'y']);
    expect(sent.askQuestion.responses[1].writeInResponse).toBe('because');
    expect(sent.askQuestion.responses[2].skipped).toBe(true);
  });

  it('cancels a pending askQuestion with cancel=true or confirm=false', async () => {
    for (const args of [[undefined, undefined, { cancel: true }], [false, undefined, undefined]] as const) {
      const { svc, handleCascadeUserInteraction } = makeService([askStep([SINGLE_Q])]);
      const res: any = await svc.hubRespondApproval(CASCADE, args[0], args[1], args[2]);
      expect(handleCascadeUserInteraction).toHaveBeenCalledWith(CASCADE, {
        trajectoryId: TRAJ,
        stepIndex: 0,
        askQuestion: { cancelled: true },
      });
      expect(res.cancelled).toBe(true);
    }
  });

  it('does NOT answer a question from confirm=true alone (no forged answer)', async () => {
    const { svc, handleCascadeUserInteraction } = makeService([askStep([SINGLE_Q])]);
    await expect(svc.hubRespondApproval(CASCADE, true)).rejects.toThrow(/does not answer a question/);
    expect(handleCascadeUserInteraction).not.toHaveBeenCalled();
  });

  it('surfaces answer validation errors without calling the hub', async () => {
    const { svc, handleCascadeUserInteraction } = makeService([askStep([SINGLE_Q])]);
    await expect(svc.hubRespondApproval(CASCADE, undefined, undefined, { answers: [{ option_ids: ['nope'] }] })).rejects.toThrow(/no option id/);
    expect(handleCascadeUserInteraction).not.toHaveBeenCalled();
  });

  it('throws when nothing is pending', async () => {
    const { svc, handleCascadeUserInteraction } = makeService([{}, { requestedInteraction: {} }]);
    await expect(svc.hubRespondApproval(CASCADE, true)).rejects.toThrow('No pending requestedInteraction in trajectory');
    await expect(svc.hubRespondApproval(CASCADE, undefined, undefined, { answers: [{ option_ids: ['a'] }] })).rejects.toThrow('No pending requestedInteraction');
    expect(handleCascadeUserInteraction).not.toHaveBeenCalled();
  });

  it('throws when the trajectory has no id', async () => {
    const { svc } = makeService([askStep([SINGLE_Q])], '');
    await expect(svc.hubRespondApproval(CASCADE, true)).rejects.toThrow('no trajectoryId');
  });

  it('still rejects genuinely unsupported interactions, listing the keys', async () => {
    const { svc, handleCascadeUserInteraction } = makeService([{ requestedInteraction: { deploy: {} } }]);
    await expect(svc.hubRespondApproval(CASCADE, true)).rejects.toThrow('Unsupported interaction variant; keys present: deploy');
    expect(handleCascadeUserInteraction).not.toHaveBeenCalled();
  });

  it('permission: confirm=true/false keep the allow + scope payload and result shape', async () => {
    for (const confirm of [true, false]) {
      const { svc, handleCascadeUserInteraction } = makeService([
        { requestedInteraction: { permission: { resource: { action: 'READ', target: 'net' } } } },
      ]);
      const res: any = await svc.hubRespondApproval(CASCADE, confirm);
      expect(handleCascadeUserInteraction).toHaveBeenCalledWith(CASCADE, {
        trajectoryId: TRAJ,
        stepIndex: 0,
        permission: { allow: confirm, scope: 'PERMISSION_SCOPE_ONCE' },
      });
      expect(res).toEqual({
        cascadeId: CASCADE,
        answered: 'permission(READ:net)',
        confirm,
        scope: 'PERMISSION_SCOPE_ONCE',
        stepIndex: 0,
        hubResponse: {},
      });
    }
  });

  it('file_permission: confirm + custom scope are forwarded', async () => {
    for (const confirm of [true, false]) {
      const { svc, handleCascadeUserInteraction } = makeService([
        { requestedInteraction: { filePermission: { absolutePathUri: 'file:///d:/x' } } },
      ]);
      await svc.hubRespondApproval(CASCADE, confirm, 'PERMISSION_SCOPE_WORKSPACE');
      expect(handleCascadeUserInteraction).toHaveBeenCalledWith(CASCADE, {
        trajectoryId: TRAJ,
        stepIndex: 0,
        filePermission: { allow: confirm, scope: 'PERMISSION_SCOPE_WORKSPACE', absolutePathUri: 'file:///d:/x' },
      });
    }
  });

  it('approval prompts never default confirm: missing confirm is refused, hub untouched', async () => {
    const { svc, handleCascadeUserInteraction } = makeService([
      { requestedInteraction: { filePermission: { absolutePathUri: 'file:///d:/x' } } },
    ]);
    await expect(svc.hubRespondApproval(CASCADE)).rejects.toThrow(/confirm \(true\/false\) is required/);
    // Supplying askQuestion-style answers must not approve a permission prompt either.
    await expect(svc.hubRespondApproval(CASCADE, undefined, undefined, { answers: [{ option_ids: ['a'] }] })).rejects.toThrow(/confirm/);
    expect(handleCascadeUserInteraction).not.toHaveBeenCalled();
  });

  it('only the newest pending interaction is answered', async () => {
    const { svc, handleCascadeUserInteraction } = makeService([
      { requestedInteraction: { permission: { resource: {} } } },
      askStep([SINGLE_Q]),
    ]);
    await svc.hubRespondApproval(CASCADE, undefined, undefined, { answers: [{ option_ids: ['c'] }] });
    expect((handleCascadeUserInteraction.mock.calls[0] as any[])[1].stepIndex).toBe(1);
  });
});

describe('askQuestion reply on the wire (hub descriptors)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function capturedRequestJson(interaction: Record<string, unknown>): Promise<any> {
    const reg = getHubRegistry();
    let captured: Uint8Array | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: Uint8Array }) => {
      captured = init.body;
      return new Response(encodeGrpcWebFrame(new Uint8Array(0)) as unknown as BodyInit, { status: 200 });
    }));
    await grpcWebCall(reg, '127.0.0.1:1', 'csrf', SERVICE, 'HandleCascadeUserInteraction', { cascadeId: CASCADE, interaction });
    const method = reg.getService(SERVICE)!.methods.find((m) => m.name === 'HandleCascadeUserInteraction')!;
    const msg = fromBinary(method.input as DescMessage, captured!.subarray(5));
    return toJson(method.input as DescMessage, msg);
  }

  it('encodes the single-select answer into CascadeUserInteraction.ask_question.responses', async () => {
    const reply = buildAskQuestionReply(
      extractPendingQuestions({ step: {}, ri: { askQuestion: { questions: [SINGLE_Q, MULTI_Q] } } }),
      { answers: [{ option_ids: ['b'] }, { option_ids: ['x', 'y'], write_in: 'both' }] },
    );
    const json = await capturedRequestJson({ trajectoryId: TRAJ, stepIndex: 7, ...reply.variant });
    expect(json.cascadeId).toBe(CASCADE);
    expect(json.interaction.trajectoryId).toBe(TRAJ);
    expect(json.interaction.stepIndex).toBe(7);
    const [r0, r1] = json.interaction.askQuestion.responses;
    expect(r0.question).toBe('Pick a deck');
    expect(r0.options).toEqual(SINGLE_Q.options);
    expect(r0.selectedOptionIds).toEqual(['b']);
    expect(r1.isMultiSelect).toBe(true);
    expect(r1.selectedOptionIds).toEqual(['x', 'y']);
    expect(r1.writeInResponse).toBe('both');
  });

  it('encodes skipped and cancelled', async () => {
    const skip = buildAskQuestionReply(
      extractPendingQuestions({ step: {}, ri: { askQuestion: { questions: [SINGLE_Q] } } }),
      { answers: [{ skip: true }] },
    );
    const j1 = await capturedRequestJson({ trajectoryId: TRAJ, stepIndex: 0, ...skip.variant });
    expect(j1.interaction.askQuestion.responses[0].skipped).toBe(true);

    const cancel = buildAskQuestionReply([], { cancel: true });
    const j2 = await capturedRequestJson({ trajectoryId: TRAJ, stepIndex: 0, ...cancel.variant });
    expect(j2.interaction.askQuestion.cancelled).toBe(true);
  });

  it('end-to-end: service → HubClient-shaped call → wire carries the selected option', async () => {
    const { svc, handleCascadeUserInteraction } = makeService([askStep([SINGLE_Q])]);
    await svc.hubRespondApproval(CASCADE, undefined, undefined, { answers: [{ option_texts: ['Spellbook'] }] });
    const [, interaction] = handleCascadeUserInteraction.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const json = await capturedRequestJson(interaction);
    expect(json.interaction.askQuestion.responses[0].selectedOptionIds).toEqual(['b']);
  });
});
