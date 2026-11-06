import type { AppSettings, Brand, Origin, Project, Studio, Track } from '@/lib/types';
import { uid } from '@/lib/utils';
import { browserTimeZone } from '@/lib/timeZone';
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

/** Bump to run a new one-time cleanup (store/cleanup.ts) on projects saved by older versions. */
export const LEGACY_CLEANUP = 1;

/** A new project's id (made before the project, so its business slot can be claimed first). */
export const newProjectId = (): string => uid('proj');

export function newProject(track: Track = 'product', origin: Origin = 'new', id: string = newProjectId()): Project {
  const now = Date.now();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    // nothing to clean up in a project made by this version
    legacyCleaned: LEGACY_CLEANUP,
    track,
    origin,
    onboarded: false,
    wizardStep: 'goal',
    niche: '',
    category: '',
    format: null,
    businessType: '',
    location: null,
    timeZone: browserTimeZone(),
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

export function defaultSettings(): AppSettings {
  return {
    ai: { serverUrl: '', useBrain: true },
    theme: 'system',
    profile: { name: '', email: '' },
    shareToCommunity: true,
  };
}
