/**
 * T3 单测夹具：全部自编段落（不是任何书的原文）。
 */
import type { Message } from '@anthropic-ai/sdk/resources/messages';
import { paraId, type ParaRow } from '../../src/types';

export const BOOK = 'fixture-book-sha';

/** 第 1 章的四段，带弯引号、重复词。 */
export const CH1 = [
  'Mrs Pell was the sort of neighbour who noticed everything and approved of nothing.',
  '“Lovely weather,” said Mr Quinn, as the rain came down sideways. ‘Lovely,’ agreed nobody.',
  'The kettle grumbled, the kettle sulked, and at last the kettle gave a reluctant whistle.',
  'Nobody in Larkspur Close had ever seen a fox wearing spectacles, and nobody intended to start now.',
];

/** 生成一段确定性的自编填充文字，正好 n 个词。 */
export function filler(n: number, seed = 0): string {
  const bank = ['the', 'quiet', 'lane', 'kept', 'its', 'secrets', 'under', 'damp', 'hedges', 'while', 'pigeons', 'argued', 'about', 'bread'];
  const w: string[] = [];
  for (let i = 0; i < n; i++) w.push(bank[(i + seed) % bank.length]!);
  return w.join(' ') + '.';
}

export function rows(chapter: number, texts: string[]): ParaRow[] {
  return texts.map((text, i) => ({ bookId: BOOK, id: paraId(chapter, i + 1), chapter, idx: i + 1, text }));
}

/** 假的 SDK Message。 */
export function fakeMessage(json: unknown, o: { model?: string; stop?: Message['stop_reason'] } = {}): Message {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: o.model ?? 'claude-haiku-5-5',
    content: o.stop === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify(json), citations: null }],
    stop_reason: o.stop ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 2000,
      output_tokens: 1500,
      cache_read_input_tokens: 2500,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Message;
}

export function item(p: Partial<Record<string, unknown>>) {
  return {
    kind: 'vocab',
    p: 'c01p0001',
    quote: '',
    occ: 1,
    lemma: '',
    level: 'B2',
    invented: false,
    fun_type: '-',
    gloss_zh: '',
    note_zh: '',
    ...p,
  };
}
