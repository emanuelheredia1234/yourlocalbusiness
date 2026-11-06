// The Manus posting window is gone: posts go out through your connected account (PostNowButton), or you
// post them yourself and mark them posted. Manus only posts in Facebook groups (ManusGroups).
//
// This file only forwards the Manus readiness helpers to the two places outside the posting work that still
// import them from here (Settings › Social accounts and the brand-voice switch). Import from './manusShared'.
export { errorCopy, manusSetupHint, useCanOfferManus, useManusReady } from './manusShared';
