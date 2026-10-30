import type { AppSettings, Brand, Origin, Project, SocialPlatform, Studio, Track } from '@/lib/types';
import { uid } from '@/lib/utils';
import { defaultCampaign } from '@/ai/local/social';
import { paletteFrom } from '@/ai/local/brand';

export function defaultBrand(): Brand {
  return {
    name: '',
    nameOptions: [],
    tagline: '',
    pitch: '',
    valueProp: '',
    audience: '',
    personality: [],
    mission: '',
    websiteUrl: '',
    slug: '',
    domainIdeas: [],
    colors: paletteFrom(['#156343', '#0E3B2A', '#F2B33D']),
    logo: { mode: 'generated', icon: 'sparkles', shape: 'circle', layout: 'horizontal', font: 'grotesk', monogram: false },
    banner: { style: 'waves', showTagline: true },
    images: [],
    socials: {},
  };
}

export function defaultStudio(): Studio {
  return {
    outline: [],
    outlineLabel: 'Outline',
    packages: [],
    operating: [],
    valueStack: [],
    price: 0,
    compareAt: 0,
    priceModel: 'one-time',
    codeAssets: [],
    listing: { title: '', tagline: '', description: '', category: '', tags: [], bookingType: 'buy', hours: '' },
  };
}

export function newProject(track: Track = 'product', origin: Origin = 'new'): Project {
  const now = Date.now();
  return {
    id: uid('proj'),
    createdAt: now,
    updatedAt: now,
    track,
    origin,
    onboarded: false,
    wizardStep: 'goal',
    niche: '',
    category: '',
    format: null,
    businessType: '',
    location: null,
    summary: '',
    ideas: [],
    idea: null,
    brand: defaultBrand(),
    studio: defaultStudio(),
    marketing: {
      leadMagnet: null,
      emails: [],
      subscribers: [],
      seo: null,
      salesPage: null,
      campaign: defaultCampaign(),
      plan: null,
    },
  };
}

const acct = () => ({ connected: false, handle: '', followers: 0 });

export function defaultSettings(): AppSettings {
  return {
    ai: { serverUrl: '', useBrain: true, simulateLatency: true },
    theme: 'system',
    profile: { name: '', email: '' },
    accounts: { instagram: acct(), facebook: acct(), tiktok: acct(), linkedin: acct(), x: acct(), youtube: acct() } as Record<SocialPlatform, ReturnType<typeof acct>>,
    marketActivity: false,
    showSampleListings: true,
    shareToCommunity: true,
  };
}
