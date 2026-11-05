// The workspace backup (Settings › Projects & data › Export backup): one JSON file the owner saves with
// a click. Only the export lives here; importing a backup stays on the Settings page, done by the owner.
// It holds the workspace as the app stores it: no API keys or sign-in tokens (those never live here),
// and no uploaded images or videos.

import { useStore } from '@/store/useStore';

/** What a backup holds (and what an import may restore). */
export const EXPORT_KEYS = ['projects', 'activeProjectId', 'posts', 'ads', 'skills', 'genLog', 'myListings', 'notices', 'settings'] as const;

/** "yourlocalbusiness-backup-2026-11-03.json" */
export function backupFileName(now = new Date()): string {
  return `yourlocalbusiness-backup-${now.toISOString().slice(0, 10)}.json`;
}

/** The backup file's text, from the workspace as it is now. */
export function backupJson(now = new Date()): string {
  const s = useStore.getState();
  const data = Object.fromEntries(EXPORT_KEYS.map((k) => [k, s[k]]));
  return JSON.stringify({ app: 'yourlocalbusiness', version: 1, exportedAt: now.toISOString(), data }, null, 2);
}
