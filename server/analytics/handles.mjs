// A profile handle from what the user typed in Settings ("@joesbakery", "joesbakery", or the profile's address).
// Only the handle goes to treg, never the typed text as it is.

const HANDLE = {
  instagram: /^[A-Za-z0-9._]{1,30}$/,
  tiktok: /^[A-Za-z0-9._]{2,24}$/,
  x: /^[A-Za-z0-9_]{1,15}$/,
  facebook: /^[A-Za-z0-9.\-]{2,80}$/,
  linkedin: /^[A-Za-z0-9\-_%]{2,100}$/,
  youtube: /^(@[A-Za-z0-9._\-]{3,30}|UC[A-Za-z0-9_\-]{22})$/,
};

/** The handle for a network, or '' when the value isn't one. */
export function handleFor(network, value) {
  let v = String(value ?? '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v) || /^(www\.)?[a-z0-9-]+\.(com|net)\//i.test(v)) {
    let u;
    try {
      u = new URL(/^https?:/i.test(v) ? v : `https://${v}`);
    } catch {
      return '';
    }
    const parts = u.pathname.split('/').filter(Boolean);
    if (network === 'linkedin') v = parts[0] === 'company' || parts[0] === 'school' || parts[0] === 'in' ? parts[1] || '' : parts[0] || '';
    else if (network === 'youtube') v = parts[0] === 'channel' ? parts[1] || '' : parts[0] || '';
    else if (network === 'facebook' && parts[0] === 'profile.php') v = u.searchParams.get('id') || '';
    else v = parts[0] || '';
  }
  if (network === 'youtube') {
    if (!v.startsWith('@') && !/^UC[A-Za-z0-9_-]{22}$/.test(v)) v = `@${v}`;
  } else v = v.replace(/^@/, '');
  return HANDLE[network]?.test(v) ? v : '';
}

export const SOCIAL_NETWORKS = Object.freeze(['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'youtube']);

/** Every network with a usable handle in project.brand.socials: { network: handle }. */
export function handlesOf(project) {
  const socials = project?.brand?.socials && typeof project.brand.socials === 'object' ? project.brand.socials : {};
  const out = {};
  for (const n of SOCIAL_NETWORKS) {
    const h = handleFor(n, socials[n]);
    if (h) out[n] = h;
  }
  return out;
}
