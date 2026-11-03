// Chat buttons for what needs the owner's click: saving, copying, and a line in the chat afterwards.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const saved = vi.hoisted(() => ({ files: [] as [string, unknown][], copied: [] as string[] }));
vi.mock('@/components/ui/download', () => ({ download: vi.fn(async (name: string, data: unknown) => (saved.files.push([name, data]), true)) }));
vi.mock('@/lib/platform', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/platform')>()), copyText: vi.fn(async (t: string) => (saved.copied.push(t), true)) }));

import { useStore } from '@/store/useStore';
import { chatOf, clearChat } from '@/store/assistant';
import { useUI } from '@/store/ui';
import { copyButton, downloadButton, noteInChat } from './buttons';

beforeEach(() => {
  saved.files = [];
  saved.copied = [];
  useStore.setState({ activeProjectId: 'p1' });
  clearChat('p1');
});

describe('chat buttons', () => {
  it('save a file only when pressed, made then if it’s a function', async () => {
    const make = vi.fn(() => 'name,email\n');
    const b = downloadButton('Download CSV', 'subscribers.csv', make);
    expect(b).toMatchObject({ label: 'Download CSV', icon: 'download' });
    expect(make).not.toHaveBeenCalled();
    await b.run();
    expect(saved.files).toEqual([['subscribers.csv', 'name,email\n']]);
  });

  it('copy text and say so', async () => {
    await copyButton('Copy caption', () => 'Fresh bread daily').run();
    expect(saved.copied).toEqual(['Fresh bread daily']);
    expect(useUI.getState().toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Copied' });
  });

  it('can add a line to the chat after the turn is over', () => {
    noteInChat('Imported 12 subscribers');
    expect(chatOf('p1').at(-1)).toMatchObject({ role: 'activity', status: 'ok', text: 'Imported 12 subscribers' });
  });
});
