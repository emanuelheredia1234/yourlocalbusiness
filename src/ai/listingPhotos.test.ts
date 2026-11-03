// What a business's listing photos are made from: the owner's own words first, a stock setting only
// when the business clearly is that kind, and the photos owners upload for each shot.
import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { GeneratedInfo, ListingShotId, MediaRef, Project } from '@/lib/types';
import { BIZ_SCENES } from './image';
import { BUSINESS_TYPES } from './knowledge';
import { generateBusinessModel, generateListing } from './local/studio';
import { businessBrief, fromOwnPhoto, listingShotMedia, offerEyebrow, OWN_PHOTO_PROVIDER, photoFileProblem, SCENE_WORDS, sceneTypeFor, withoutPlaceholders } from './listingPhotos';
import { coverMedia } from './productFiles';

function biz(type: string, category = '', city = 'Phoenix'): Project {
  const p = newProject('business', 'new');
  p.businessType = type;
  p.niche = type;
  p.category = category;
  p.location = city ? { city, region: 'AZ' } : null;
  p.brand = { ...p.brand, name: 'Sparkle Co' };
  // the packages and listing a new project gets at setup (from the shared business-type templates)
  p.studio.packages = generateBusinessModel(p).packages;
  p.studio.listing = generateListing(p);
  return p;
}

describe('the stock setting for a business photo', () => {
  it('has words for every stock setting, and a setting for every business type', () => {
    expect(Object.keys(SCENE_WORDS).sort()).toEqual(Object.keys(BIZ_SCENES).sort());
    for (const bt of BUSINESS_TYPES) expect(SCENE_WORDS[bt.id], bt.id).toBeTruthy();
  });

  it('is used when the business clearly is that kind', () => {
    expect(sceneTypeFor('Home Cleaning', 'Eco-friendly deep cleaning')).toBe('cleaning');
    expect(sceneTypeFor('Coffee Shop', 'Specialty espresso & pastries')).toBe('cafe');
    expect(sceneTypeFor('Hair Salon')).toBe('salon');
    expect(sceneTypeFor('Personal Training')).toBe('fitness-studio');
    expect(sceneTypeFor('Landscaping')).toBe('landscaping');
    expect(sceneTypeFor('Family-owned lawn care')).toBe('landscaping');
    expect(sceneTypeFor('Dog Grooming')).toBe('pet-services');
    expect(sceneTypeFor('Bookkeeping')).toBe('bookkeeping');
    expect(sceneTypeFor('Photography Studio')).toBe('photography');
    expect(sceneTypeFor('Tutoring')).toBe('tutoring');
    expect(sceneTypeFor('Marketing Agency')).toBe('consulting');
    expect(sceneTypeFor('Barbershop')).toBe('barber');
    expect(sceneTypeFor('Mexican restaurant')).toBe('restaurant');
    expect(sceneTypeFor('Steakhouse')).toBe('restaurant');
    expect(sceneTypeFor('Gift shop')).toBe('retail');
    // a type of only generic words: the specialty says what it is
    expect(sceneTypeFor('Small business', 'House cleaning')).toBe('cleaning');
  });

  it('is left out where the shared business-type matcher only finds part of a word', () => {
    // "skin·car·e", "car·pet", "tea·cher", "s·tree·t", "pr·event·ion", plus "daycare", "shop" and "cleaning" that mean something else here
    for (const t of ['Skincare studio', 'Senior home care', 'Healthcare clinic', 'Child daycare', 'Carpet installation', 'Music teacher', 'Street tacos', 'Pest control prevention', 'Tattoo shop', 'Pool cleaning']) {
      expect(sceneTypeFor(t), t).toBeNull();
    }
  });

  it('is left out for a kind of business the setting doesn’t show', () => {
    for (const t of ['Auto Detailing', 'Bakery', 'Nail salon', 'Yoga studio', 'Food truck', 'HVAC', 'Wedding photography', 'Dog walking', 'Piano lessons', 'Commercial cleaning', 'Men’s grooming']) {
      expect(sceneTypeFor(t), t).toBeNull();
    }
    expect(sceneTypeFor('Cleaning', 'Pool and patio cleaning')).toBeNull();
    expect(sceneTypeFor('Salon', 'Gel nails and pedicures')).toBeNull();
    for (const t of ['Dentist', 'Law firm', 'Real estate', 'Chiropractor', 'Massage', 'Moving', 'Locksmith', 'Driving school', 'Pressure washing', 'Interior design', 'Physical therapy', 'Cake decorator', '']) {
      expect(sceneTypeFor(t), t).toBeNull();
    }
  });
});

describe('what a business’s listing photos are made from', () => {
  it('leads with the owner’s own words, without the business name', () => {
    const p = biz('Pool cleaning', 'Residential pool maintenance');
    p.brand.name = 'Sparkle Pools';
    p.studio.listing.title = 'Sparkle Pools | Weekly pool service';
    p.summary = 'Sparkle Pools keeps backyard pools clear. We test the water every visit. Family owned.';
    p.brand.audience = 'Homeowners with backyard pools who are tired of green water';
    p.studio.packages = [
      {
        id: 'k1',
        name: 'Weekly Service',
        price: 140,
        priceModel: 'monthly',
        description: '',
        // the owner's lines, a placeholder, and a line from the house-cleaning template
        includes: ['Skim, brush and vacuum', 'Water test and chemical balance (15 min)', '[Anything extra this package includes]', 'Room-by-room cleaning (kitchen, baths, living, bedrooms)'],
        popular: true,
      },
    ];
    const b = businessBrief(p);
    expect(b).toMatchObject({
      what: 'pool cleaning',
      business: 'a local pool cleaning business',
      person: false,
      specialty: 'Residential pool maintenance',
      offerName: 'Weekly Service',
      offerItems: ['Skim, brush and vacuum', 'Water test and chemical balance'],
      title: 'Weekly pool service',
      summary: 'The business keeps backyard pools clear. We test the water every visit.',
      audience: 'homeowners with backyard pools',
      city: 'Phoenix',
      sceneId: null,
    });
    expect(JSON.stringify(b)).not.toContain('Sparkle');
  });

  it('takes out only the whole business name, and keeps fields as phrases', () => {
    const p = biz('Coffee Shop', 'Coffee roasted in house.');
    p.brand.name = 'Co';
    p.summary = 'Co roasts coffee for the neighborhood. Come by.';
    p.studio.listing.title = 'Coffee and cocoa by Co.';
    const b = businessBrief(p);
    expect(b.specialty).toBe('Coffee roasted in house');
    expect(b.summary).toBe('The business roasts coffee for the neighborhood. Come by.');
    expect(b.title).toBe('Coffee and cocoa');
  });

  it('names the business as a place or a person, never “business business”', () => {
    expect(businessBrief(biz('Dentist'))).toMatchObject({ business: 'a local dentist', person: true });
    expect(businessBrief(biz('Music teacher'))).toMatchObject({ business: 'a local music teacher', person: true });
    expect(businessBrief(biz('Coffee Shop')).business).toBe('a local coffee shop');
    expect(businessBrief(biz('Law firm')).business).toBe('a local law firm');
    expect(businessBrief(biz('Steakhouse')).business).toBe('a local steakhouse');
    expect(businessBrief(biz('Cleaning business')).business).toBe('a local cleaning business');
    expect(businessBrief(biz('Cleaning services')).business).toBe('local cleaning services');
    expect(businessBrief(biz('Movers')).business).toBe('local movers');
    expect(businessBrief(biz('HVAC')).business).toBe('a local HVAC business');
    expect(businessBrief(biz('Street tacos')).business).toBe('a local street tacos business');
    expect(businessBrief(biz('')).business).toBe('a local business');
  });

  it('keeps a template’s package lines only when the template is for this kind of business', () => {
    // house cleaning: its own template fits
    expect(businessBrief(biz('Home Cleaning')).offerItems[0]).toBe('Standard Clean');
    // the shared matcher reads "steakhouse" as a café, so its packages came from the café template: left out
    const steak = businessBrief(biz('Steakhouse'));
    expect(steak.offerItems).toEqual([]);
    expect(steak.offerName).toBe('');
    // pool cleaning got the house-cleaning template: left out too
    expect(businessBrief(biz('Pool cleaning')).offerItems).toEqual([]);
  });

  it('shows a customer for a place that sells things, and the work for a service', () => {
    expect(businessBrief(biz('Bakery')).shop).toBe(true);
    expect(businessBrief(biz('Coffee Shop')).shop).toBe(true);
    const restaurant = biz('Mexican restaurant');
    restaurant.studio.listing.bookingType = 'book';
    expect(businessBrief(restaurant).shop).toBe(true);
    const salon = biz('Hair Salon');
    salon.studio.listing.bookingType = 'buy';
    expect(businessBrief(salon).shop).toBe(false);
    // "Buy" left over from the café template the shared matcher picked for a music teacher
    const teacher = biz('Music teacher');
    expect(teacher.studio.listing.bookingType).toBe('buy');
    expect(businessBrief(teacher).shop).toBe(false);
    expect(businessBrief(biz('Pool cleaning')).shop).toBe(false);
  });

  it('leaves out the built-in brand kit’s stand-in audience', () => {
    const p = biz('Dentist');
    p.brand.audience = 'People getting serious about dentist who are tired of not knowing where to start.';
    expect(businessBrief(p).audience).toBe('');
  });
});

describe('the words typeset on listing graphics', () => {
  it('never include a line still waiting for the owner', () => {
    expect(withoutPlaceholders(['Room-by-room cleaning', 'Rooms and add-ons covered: [your checklist]', '[Anything extra this package includes]', ' ', 'See [our site](https://x.test)'])).toEqual(['Room-by-room cleaning', 'See [our site](https://x.test)']);
  });

  it('the offer card names the business in the owner’s words and the city, on one line', () => {
    expect(offerEyebrow(biz('Pool cleaning'))).toBe('Pool cleaning · Phoenix');
    // the shared matcher would have printed "Auto Detailing & Repair" for a skincare studio
    expect(offerEyebrow(biz('Skincare studio'))).toBe('Skincare studio · Phoenix');
    expect(offerEyebrow(biz('Pool cleaning', '', ''))).toBe('Pool cleaning');
    // too long for one line: the type alone, cut at a word and not after "and"
    expect(offerEyebrow(biz('Eco-friendly residential and commercial cleaning services'))).toBe('Eco-friendly residential');
    expect(offerEyebrow(biz('Residential and commercial cleaning'))).toBe('Residential and commercial cleaning');
    expect(offerEyebrow(biz(''))).toBe('Local business · Phoenix');
    const product = newProject('product', 'new');
    product.format = 'course';
    expect(offerEyebrow(product)).toBe('Online Course');
  });
});

const media = (id: string, createdAt: number, generated?: Partial<GeneratedInfo>): MediaRef => ({
  id,
  kind: 'image',
  name: `${id}.jpg`,
  mime: 'image/jpeg',
  size: 100,
  createdAt,
  ...(generated ? { generated: { kind: 'photo', provider: 'Meta Muse', prompt: 'p', purpose: 'listing', aspect: '3:2', final: false, createdAt, ...generated } } : {}),
});

describe('which image a listing shot shows', () => {
  it('shows your uploaded photo first, else the newest image made for it', () => {
    const p = biz('Pool cleaning');
    const shot = (id: string, s: ListingShotId, at: number) => media(id, at, { shot: s });
    p.brand.images = [shot('old', 'hero', 1), shot('new', 'hero', 2), shot('side', 'lifestyle', 3), media('mine', 4)];
    expect(listingShotMedia(p, 'hero')?.id).toBe('new');
    expect(listingShotMedia(p, 'inside')).toBeUndefined();
    p.studio.listing.shotImageIds = { hero: 'mine' };
    expect(listingShotMedia(p, 'hero')?.id).toBe('mine');
    // the e-book cover still finds the listing's hero photo when no cover is picked
    expect(coverMedia(p)?.id).toBe('mine');
    // your photo removed from your brand images: the shot goes back to the newest one made
    p.brand.images = p.brand.images.filter((m) => m.id !== 'mine');
    expect(listingShotMedia(p, 'hero')?.id).toBe('new');
  });

  it('counts your photo, and your photo with your details on it, as yours', () => {
    expect(fromOwnPhoto(media('a', 1))).toBe(true);
    expect(fromOwnPhoto(media('b', 1, { shot: 'inside' }))).toBe(false);
    expect(fromOwnPhoto(media('c', 1, { kind: 'design', provider: OWN_PHOTO_PROVIDER, shot: 'inside', artId: 'a' }))).toBe(true);
    expect(fromOwnPhoto(undefined)).toBe(false);
  });
});

describe('uploading a listing photo', () => {
  it('takes JPG, PNG and WebP, and explains HEIC', () => {
    expect(photoFileProblem({ name: 'shop.jpg', type: 'image/jpeg' })).toBeNull();
    expect(photoFileProblem({ name: 'shop.png', type: 'image/png' })).toBeNull();
    expect(photoFileProblem({ name: 'shop.webp', type: 'image/webp' })).toBeNull();
    expect(photoFileProblem({ name: 'shop.JPG', type: '' })).toBeNull();
    expect(photoFileProblem({ name: 'IMG_0001.HEIC', type: 'image/heic' })).toMatch(/HEIC.*JPG, PNG or WebP/);
    expect(photoFileProblem({ name: 'IMG_0001.heic', type: '' })).toMatch(/HEIC/);
    expect(photoFileProblem({ name: 'anim.gif', type: 'image/gif' })).toBe('Use a JPG, PNG or WebP photo.');
    expect(photoFileProblem({ name: 'clip.mp4', type: 'video/mp4' })).toBe('Use a JPG, PNG or WebP photo.');
  });
});
