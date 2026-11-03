// Helpers for testing assistant tools (used by tests only, never by the app): a workspace in the store,
// a stand-in for the confirm, the windows and pages, and running a tool the way a turn runs it, under
// its class's rules. See testing.test.ts for one test per class.

import type { Post, Project } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { defaultSettings, newProject } from '@/store/defaults';
import { chatOf, clearChat, type ChatMessage } from '@/store/assistant';
import { setAssistantHost } from './host';
import { createRegistry, type AnyTool, type DangerSpec, type PubWindow } from './registry';
import { runAction } from './run';
import type { StepResult } from './prompt';

export const TEST_PROJECT = 'p1';

/** A post of the test project (planned for 2 Jan 2020, so it's due), with whatever you change. */
export function testPost(id: string, extra: Partial<Post> = {}): Post {
  return { id, projectId: TEST_PROJECT, status: 'scheduled', platform: 'instagram', format: 'image', style: 'minimal', postType: 'tip', headline: `Headline ${id}`, visualPrompt: '', caption: 'Caption', hashtags: [], scheduledAt: '2020-01-02T10:00:00.000Z', watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1, ...extra } as Post;
}

/** A fresh workspace with one set-up project ("Copper Kettle", id p1) as the active one. */
export function seedWorkspace(o: { track?: Project['track']; project?: Partial<Project>; posts?: Post[] } = {}): Project {
  const base = newProject(o.track ?? 'business', 'existing');
  const project: Project = { ...base, id: TEST_PROJECT, onboarded: true, ...o.project, brand: { ...base.brand, name: 'Copper Kettle', ...o.project?.brand } };
  useStore.setState({ projects: [project], activeProjectId: TEST_PROJECT, posts: o.posts ?? [], ads: [], notices: [], myListings: [], genLog: [], settings: defaultSettings() });
  clearChat(TEST_PROJECT);
  return project;
}

/**
 * Stand-ins for what a turn shows the owner: the danger confirm answers `confirm` (default no), windows
 * and pages open (recorded). Call restore() after the test.
 */
export function fakeHost(o: { confirm?: boolean; pageOpens?: boolean } = {}) {
  const calls = { dangers: [] as DangerSpec[], windows: [] as PubWindow[], pages: [] as [string, string | undefined][] };
  const restore = setAssistantHost({
    confirmDanger: async (spec) => (calls.dangers.push(spec), o.confirm ?? false),
    openWindow: async (w) => (calls.windows.push(w), true),
    openPage: async (route, tab) => (calls.pages.push([route, tab]), o.pageOpens ?? true),
    availability: () => ({ ok: true, reason: '', settings: false }),
  });
  return { calls, restore };
}

/** Run a tool as a turn would (arguments checked, its class's rules applied). Pass `tools` to run ones not registered yet. */
export function runTool(tool: string, args: Record<string, unknown> = {}, o: { tools?: AnyTool[]; signal?: AbortSignal } = {}): Promise<StepResult> {
  return runAction({ tool, args }, { projectId: useStore.getState().activeProjectId ?? TEST_PROJECT, signal: o.signal ?? new AbortController().signal, step: 1 }, o.tools ? createRegistry(o.tools) : undefined);
}

/** The test project's chat (activity lines, cards…). */
export const testChat = (): ChatMessage[] => chatOf(useStore.getState().activeProjectId ?? TEST_PROJECT);
