// What the Dashboard shows next to an action, shared by this week's plan rows and today's action card: where it
// happens (its area), its icon, and whether its button makes the AI write something.
import type { ReactNode } from 'react';
import { AtSign, BarChart3, Brain, CalendarDays, CodeXml, Compass, Globe, Link2, Mail, MapPin, Megaphone, MessageCircle, PenSquare, Store, Target, Users } from 'lucide-react';
import type { ActionKind } from '@/lib/strategyTypes';
import type { MorningKind } from '@/lib/integrations/types';

/** Where an action happens, for its row's meta line. */
export const AREA: Record<ActionKind, string> = {
  build_page: 'Your page',
  publish_page: 'Your page',
  link_settings: 'Links',
  campaign_setup: 'Social',
  plan_30: 'Social',
  batch_7: 'Social',
  write_post: 'Social post',
  calendar: 'Calendar',
  lead_magnet: 'Email',
  welcome_emails: 'Email',
  outreach: 'Email',
  code_asset: 'Studio',
  listing: 'Marketplace',
  listing_images: 'Marketplace',
  product_file: 'Studio',
  packages: 'Studio',
  socials: 'Settings',
  website: 'Settings',
  brain: 'Brain',
  ads: 'Ads',
  offline: 'Outside the app',
};
export const ICON: Partial<Record<ActionKind, ReactNode>> = {
  build_page: <Globe />,
  publish_page: <Globe />,
  link_settings: <Link2 />,
  campaign_setup: <Megaphone />,
  plan_30: <CalendarDays />,
  batch_7: <CalendarDays />,
  write_post: <PenSquare />,
  calendar: <CalendarDays />,
  lead_magnet: <Mail />,
  welcome_emails: <Mail />,
  outreach: <Mail />,
  code_asset: <CodeXml />,
  listing: <Store />,
  listing_images: <Store />,
  socials: <AtSign />,
  website: <Globe />,
  brain: <Brain />,
  ads: <Target />,
  offline: <MapPin />,
};
/** The actions whose button leads to the AI writing something (the rest open a page). */
export const WRITES = new Set<ActionKind>(['write_post', 'build_page', 'plan_30', 'batch_7', 'lead_magnet', 'welcome_emails', 'ads']);

/** The morning action's own kinds, next to the plan's. */
export const MORNING_AREA: Record<MorningKind, string> = { ...AREA, leads: 'Leads', analytics: 'Analytics', strategy: 'Strategy', assistant: 'Assistant' };
export const MORNING_ICON: Partial<Record<MorningKind, ReactNode>> = { ...ICON, leads: <Users />, analytics: <BarChart3 />, strategy: <Compass />, assistant: <MessageCircle /> };
/** A kind whose button makes the AI write (the morning card's Do it is then the AI outline button). */
export const writes = (k: MorningKind): boolean => (WRITES as Set<string>).has(k);
