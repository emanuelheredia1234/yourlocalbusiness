// The posting adapter for each network (spec §1.7). Pinterest is phase 2.
import { facebook } from './facebook.mjs';
import { instagram } from './instagram.mjs';
import { linkedin } from './linkedin.mjs';
import { tiktok } from './tiktok.mjs';
import { x } from './x.mjs';
import { youtube } from './youtube.mjs';

export const ADAPTERS = Object.freeze({ facebook, instagram, linkedin, tiktok, x, youtube });
