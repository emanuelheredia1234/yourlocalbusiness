// Where the analytics panels send people: Settings › Connected accounts (to connect or add handles), the
// Marketing hub (where Update lives), and a source's own page.
import { navigate } from '@/lib/router';
import { useUI } from '@/store/ui';
import type { ConnectPlatform } from '@/lib/integrations/types';

export function openConnectedAccounts(): void {
  useUI.getState().setSettingsTab('accounts');
  void navigate('workspace-settings');
}

export function openMarketingHub(): void {
  void navigate('marketing');
}

/** The names people see for each account. */
export const PLATFORM_NAMES: Record<ConnectPlatform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  x: 'X',
  youtube: 'YouTube',
  pinterest: 'Pinterest',
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads',
  microsoft_ads: 'Microsoft Ads',
  tiktok_ads: 'TikTok Ads',
  google_search_console: 'Search Console',
};
