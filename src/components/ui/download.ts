import { saveFile } from '@/lib/platform';
import { toast } from '@/store/ui';

/** Offer a file to the viewer and report the outcome in a toast. */
export async function download(filename: string, data: string | Blob): Promise<boolean> {
  const r = await saveFile(filename, data);
  if (r === 'saved') {
    toast({ kind: 'success', title: `Saved ${filename}` });
    return true;
  }
  if (r === 'unavailable') toast({ kind: 'error', title: 'Downloads aren’t available here', body: 'Use Copy instead, or open the app in a full browser tab.' });
  else if (r === 'busy') toast({ kind: 'info', title: 'Another save is waiting for your answer', body: 'Finish that one, then try again.' });
  else if (r === 'error') toast({ kind: 'error', title: 'Couldn’t save the file', body: 'Please try again.' });
  return false;
}
