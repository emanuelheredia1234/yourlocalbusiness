// Chat buttons for what only the owner's own click may do in a browser: saving a file, copying to the
// clipboard, picking a file. A tool returns them in its result; they show under its line in the chat
// and work until the page reloads (their handlers live in memory only).

import { copyText } from '@/lib/platform';
import { download } from '@/components/ui/download';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { addMessage } from '@/store/assistant';
import type { ChatButton } from './registry';

type Data = string | Blob;

/** Save a file. Pass the data, or a function that makes it on the click (keep it quick: the click's permission doesn't last). */
export function downloadButton(label: string, filename: string, data: Data | (() => Data)): ChatButton {
  return { label, icon: 'download', run: () => download(filename, typeof data === 'function' ? data() : data).then(() => undefined) };
}

/** Copy text, and say whether it worked. */
export function copyButton(label: string, text: string | (() => string)): ChatButton {
  return {
    label,
    icon: 'copy',
    run: async () => {
      const ok = await copyText(typeof text === 'function' ? text() : text);
      toast(ok ? { kind: 'success', title: 'Copied' } : { kind: 'error', title: 'Copy was blocked', body: 'Select the text and copy it yourself.' });
    },
  };
}

/** Open the file picker (call it from a button's click) and resolve to the chosen file, or null. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    let done = false;
    const finish = (f: File | null) => {
      if (done) return;
      done = true;
      resolve(f);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    // some browsers send nothing when the picker is cancelled: the page getting focus back ends it
    window.addEventListener('focus', () => setTimeout(() => finish(input.files?.[0] ?? null), 600), { once: true });
    input.click();
  });
}

/** Pick a file and hand it to `use` (e.g. import a CSV). What `use` says back goes in the chat with noteInChat. */
export function fileButton(label: string, accept: string, use: (file: File) => void | Promise<void>): ChatButton {
  return {
    label,
    icon: 'upload',
    run: async () => {
      const f = await pickFile(accept);
      if (f) await use(f);
    },
  };
}

/** A line in the active project's chat, for what a button did after the turn ended ("Imported 12 subscribers"). */
export function noteInChat(text: string, ok = true): void {
  const pid = useStore.getState().activeProjectId;
  if (pid) addMessage(pid, { role: 'activity', text, status: ok ? 'ok' : 'failed' });
}
