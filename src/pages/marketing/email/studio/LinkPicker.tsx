// Where a button, a linked image or a text link goes (P5 §A2): the lead magnet's download, the page, a published
// Code & assets page, one of the business's offers, or a web address. Choices that can't work yet are disabled
// and say what fixes them.

import { useId } from 'react';
import type { Link } from '../../../../../shared/email/blocks.mjs';
import type { Project } from '@/lib/types';
import { pageLink } from '@/lib/pageLink';
import { useProjectOffers } from '@/store/offers';
import { offerPrice } from '@/lib/offers';
import { Field } from '@/components/ui/primitives';
import { missingLinkFix } from '../shared';

export interface LinkChoice {
  kind: Link['kind'];
  label: string;
  /** why it can't be chosen ('' when it can) */
  disabled: string;
}

/** The kinds of link, with why each can't be used yet. */
export function linkChoices(p: Project, offersOn: boolean): LinkChoice[] {
  const published = p.studio.codeAssets.some((a) => a.published?.url);
  return [
    {
      kind: 'magnet',
      label: 'Your free download',
      disabled: p.marketing.leadMagnet?.delivery?.link ? '' : missingLinkFix(p, '{{lead_magnet_link}}', 'short'),
    },
    {
      kind: 'page',
      label: 'Your page',
      disabled: pageLink(p) ? '' : missingLinkFix(p, '{{product_link}}', 'short'),
    },
    {
      kind: 'asset',
      label: 'A published asset',
      disabled: published ? '' : 'Publish one in Studio › Code & assets first',
    },
    ...(offersOn ? [{ kind: 'offer' as const, label: 'One of your offers', disabled: '' }] : []),
    { kind: 'url', label: 'A web address', disabled: '' },
  ];
}

export function LinkPicker({ project, value, onChange, label = 'Link' }: { project: Project; value: Link; onChange: (l: Link) => void; label?: string }) {
  const id = useId();
  const { on: offersOn, offers } = useProjectOffers(project.id);
  const choices = linkChoices(project, offersOn || value.kind === 'offer');
  const current = choices.find((c) => c.kind === value.kind);
  const pick = (kind: Link['kind']) => {
    if (kind === value.kind) return;
    if (kind === 'magnet' || kind === 'page') onChange({ kind });
    else if (kind === 'asset')
      onChange({
        kind,
        assetId: project.studio.codeAssets.find((a) => a.published?.url)?.id ?? '',
      });
    else if (kind === 'offer') onChange({ kind, offerId: offers[0]?.id ?? '' });
    else onChange({ kind: 'url', url: '' });
  };
  return (
    <Field label={label} htmlFor={`${id}-kind`} hint={current?.disabled || undefined}>
      <select id={`${id}-kind`} className="select" value={value.kind} onChange={(e) => pick(e.target.value as Link['kind'])}>
        {choices.map((c) => (
          <option key={c.kind} value={c.kind} disabled={!!c.disabled && c.kind !== value.kind}>
            {c.label}
            {c.disabled ? ` (${c.disabled})` : ''}
          </option>
        ))}
      </select>
      {value.kind === 'asset' && (
        <select aria-label="Which asset" className="select mt-2" value={value.assetId} onChange={(e) => onChange({ kind: 'asset', assetId: e.target.value })}>
          {project.studio.codeAssets.map((a) => (
            <option key={a.id} value={a.id} disabled={!a.published?.url}>
              {a.name}
              {a.published?.url ? '' : ' (Publish it first)'}
            </option>
          ))}
        </select>
      )}
      {value.kind === 'offer' && (
        <select aria-label="Which offer" className="select mt-2" value={value.offerId} onChange={(e) => onChange({ kind: 'offer', offerId: e.target.value })}>
          {!offers.some((o) => o.id === value.offerId) && <option value={value.offerId}>Choose an offer…</option>}
          {offers.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}
              {offerPrice(o) ? ` · ${offerPrice(o)}` : ''}
              {o.environment === 'sandbox' ? ' · Test mode' : ''}
            </option>
          ))}
        </select>
      )}
      {value.kind === 'url' && (
        <input aria-label="Web address" className="input mt-2 font-mono" placeholder="https://" value={value.url} onChange={(e) => onChange({ kind: 'url', url: e.target.value })} />
      )}
    </Field>
  );
}
