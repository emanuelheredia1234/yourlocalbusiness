// Stand-in research for tests and browser QA (Strategy): made-up sources on reserved example domains
// (RFC 2606, titled "QA stand-in" so nobody mistakes them for research), and the scripted answer for
// each Strategy step. server/test/mock-providers.mjs answers with them; the app's tests copy the same
// objects (src/ai/strategyTasks.test.ts). Each answer holds mistakes on purpose (an invented URL, an
// unsourced number, unknown ids, a link in an email body, a prediction): the app's merges must fix them.

/** What the stand-in web search "found": source 3 was looked at but never cited. */
export const QA_SOURCES = [
  { url: 'https://example.com/qa-research/where-buyers-look', title: 'QA stand-in source 1 (not a real page)', page_age: 'October 1, 2026' },
  { url: 'https://example.org/qa-research/content-that-works?utm_source=qa', title: 'QA stand-in source 2 (not a real page)' },
  { url: 'https://example.net/qa-research/looked-at-not-cited', title: 'QA stand-in source 3 (looked at, not cited)' },
];

/**
 * The scripted JSON answer for each Strategy step, by the marker its prompt starts with
 * ([ylb-strategy:<step> v1]; the app's src/ai/strategyTasks.ts writes the markers).
 */
export const STRATEGY_QA = {
  research: {
    summary: 'QA stand-in research: made-up findings for testing, not real research.',
    findings: [
      { topic: 'buyers', text: 'QA: buyers compare local options on map listings before they call.', sources: ['https://example.com/qa-research/where-buyers-look'] },
      { topic: 'social', text: 'QA: short how-to videos get attention in this niche.', sources: ['https://example.org/qa-research/content-that-works'] },
      { topic: 'promote', text: 'QA: this cites a made-up address the search never returned.', sources: ['https://invented.example/not-a-source'] },
      { topic: 'offers', text: 'QA: no source, so this is general knowledge.', sources: [] },
      { topic: 'seo', text: 'QA: 73% of buyers search on their phone.', sources: [] },
    ],
  },
  promote: {
    positioning: { line: 'QA: the friendly local option for busy families.', who: 'QA: busy families nearby', why: 'QA stand-in.', sources: [1] },
    channels: [
      { name: 'Google Business Profile', channelType: 'search', platform: '', priority: 1, why: 'QA: buyers compare map listings.', how: ['QA: add photos', 'QA: add your booking link'], sources: [1] },
      { name: 'Instagram', channelType: 'social', platform: 'instagram', priority: 1, why: 'QA: short videos get attention.', how: ['QA: post short how-tos'], sources: [2] },
      { name: 'Local Facebook groups', channelType: 'community', platform: 'facebook', priority: 2, why: 'QA: general knowledge.', how: ['QA: answer questions'], sources: [] },
      { name: 'QA bad channel', channelType: 'spaceship', platform: 'myspace', priority: 7, why: 'QA: wrong ids get fixed.', how: [], sources: [99] },
    ],
    page: { pageType: 'booking', why: 'QA: people want to pick a time.', secondType: 'lead', secondWhy: 'QA: for questions first.', sources: [1] },
    links: {
      instagram: { placement: 'bio', why: 'QA: captions don’t make links clickable.', sources: [] },
      facebook: { placement: 'comment', why: 'QA stand-in.', sources: [2] },
      tiktok: { placement: 'sidebar', why: 'QA: a wrong placement.', sources: [] },
    },
  },
  content: {
    pillars: [
      { name: 'QA quick wins', why: 'QA stand-in.', ideas: ['QA: 3 signs your oven needs a deep clean', 'QA: this idea is far too long for a post topic because it keeps on going and going until the app has to cut it short'] },
      { name: 'QA behind the scenes', why: 'QA stand-in.', ideas: ['QA: a morning at the shop'] },
    ],
    formats: [
      { platform: 'instagram', what: 'QA: short how-to videos', why: 'QA.', sources: [2] },
      { platform: 'myspace', what: 'QA: a network the app doesn’t know', why: 'QA.', sources: [] },
    ],
    campaign: { goal: 'leads', platforms: ['instagram', 'facebook', 'myspace'], postMix: { educational: 2, tip: 3, question: 1, sales: 1, bts: 2, memes: 3 }, videoShare: 'some', why: 'QA stand-in.', sources: [2] },
    ideas: [
      { headline: 'QA: before and after of a kitchen', postType: 'bts', platform: 'instagram', why: 'QA.' },
      { headline: 'QA: an unknown post type becomes a tip', postType: 'rant', platform: 'instagram', why: 'QA.' },
    ],
  },
  assets: {
    assets: [
      { kind: 'page', title: 'QA: a booking page', why: 'QA.', codeKind: '', leadMagnetType: '', prompt: '', sources: [1] },
      { kind: 'lead_magnet', title: 'QA: a checklist', why: 'QA.', codeKind: '', leadMagnetType: 'checklist', prompt: '', sources: [] },
      { kind: 'code', title: 'QA: a price calculator', why: 'QA.', codeKind: 'calculator', leadMagnetType: '', prompt: 'QA: a calculator that estimates the cost of a deep clean from the number of rooms', sources: [] },
      { kind: 'hologram', title: 'QA: an unknown kind', why: 'QA.', codeKind: '', leadMagnetType: '', prompt: '', sources: [] },
    ],
    seo: { audience: 'QA: busy families nearby', angle: 'QA: trusted by 500 families.', objections: ['QA: Is it safe for pets?'], keywords: ['QA House Cleaning Austin'], cta: 'book', why: 'QA.', sources: [1] },
  },
  outreach: {
    email: { leadMagnetType: 'checklist', idea: 'QA: a move-out cleaning checklist', welcomeAngle: 'QA: practical tips first', why: 'QA.', sources: [] },
    templates: [
      { who: 'QA: property managers nearby', purpose: 'partner', subject: 'QA: a quick question about move-out cleans', body: 'Hi [Name],\n\nQA stand-in body. See https://evil.example/now for details.\n\n[Your name]', followUp: 'QA: a short nudge.', why: 'QA.' },
      { who: 'QA: past customers', purpose: 'fans', subject: 'QA: thank you', body: 'Hi [Name],\n\nYou will get 20% off forever. Thanks again for choosing us.\n\n[Your name]', followUp: '', why: 'QA.' },
    ],
  },
  plan: {
    summary: 'QA stand-in plan.',
    weeks: [ { week: 1, focus: 'QA: get ready', goal: 'QA.' }, { week: 2, focus: 'QA: launch', goal: 'QA.' }, { week: 3, focus: 'QA: show up', goal: 'QA.' }, { week: 4, focus: 'QA: follow up', goal: 'QA.' } ],
    actions: [
      { week: 1, title: 'QA: build your booking page', detail: 'QA.', kind: 'build_page', pageType: 'booking', topic: '', codeKind: '', leadMagnetType: '', platform: '', sources: [1] },
      { week: 1, title: 'QA: set where your link goes', detail: 'QA.', kind: 'link_settings', pageType: '', topic: '', codeKind: '', leadMagnetType: '', platform: '', sources: [] },
      { week: 2, title: 'QA: write a how-to post', detail: 'QA.', kind: 'write_post', pageType: '', topic: 'QA: 3 signs your oven needs a deep clean', codeKind: '', leadMagnetType: '', platform: 'instagram', sources: [2] },
      { week: 2, title: 'QA: email five property managers', detail: 'QA.', kind: 'outreach', pageType: '', topic: '', codeKind: '', leadMagnetType: '', platform: '', sources: [] },
      { week: 9, title: 'QA: a wrong week and kind', detail: 'QA: the app gives it no button.', kind: 'launch_rocket', pageType: '', topic: '', codeKind: '', leadMagnetType: '', platform: '', sources: [], route: '#workspace-settings' },
    ],
    habits: ['QA: reply to messages the same day'],
    measure: [ { what: 'QA: sign-ups from your page', where: 'app', why: 'QA.' }, { what: 'QA: you will get 40 bookings', where: 'app', why: 'QA.' } ],
  },
};
export const STRATEGY_SCRIPTED = Object.entries(STRATEGY_QA).map(([step, answer]) => [`[ylb-strategy:${step} v1]`, JSON.stringify(answer)]);
