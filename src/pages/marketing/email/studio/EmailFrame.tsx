// The email as subscribers get it (P5 §A3): the shared renderer's HTML in a sandboxed iframe (no scripts, no
// same-origin: links may only open a new tab), Desktop or Phone width, with the From / To / Subject header as
// the app's own chrome above it. Warnings from the renderer show under it in plain words.

import { useMemo, useState } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import type { EmailDoc, EmailStep, Project } from '@/lib/types';
import { cn } from '@/lib/utils';
import { emailHtml, unhostedImages } from '@/lib/emailDoc';
import { renderTokens } from '@/ai/local/email';
import { Callout, Segmented } from '@/components/ui/primitives';
import { RenderError } from '../../../../../shared/email/render.mjs';
import { emailTokens } from '../shared';

export const FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/** A renderer warning in plain words ('' for ones the owner needn't see). */
export function warningText(code: string): string {
  const [kind, arg = ''] = code.split(':');
  switch (kind) {
    case 'CONTRAST_TEXT':
      return 'The text colour was too close to the background, so the email uses dark text on white.';
    case 'CONTRAST_BUTTON':
      return 'The button’s text was hard to read on its colour, so a readable one is used.';
    case 'GMAIL_CLIP':
      return 'This email is large: Gmail cuts messages over 102 KB and hides the rest behind “View entire message”.';
    case 'UNKNOWN_TAG':
      return `{{${arg}}} isn’t a merge tag the app fills in: it shows as written.`;
    case 'UNKNOWN_BUY_LINK':
      return 'A buy link isn’t one of this business’s offers: choose one of its offers.';
    case 'UNKNOWN_ASSET_LINK':
      return 'A link goes to an asset that isn’t published: publish it first.';
    case 'NO_LINK':
      return arg === 'magnet'
        ? 'A link goes to your free download, which isn’t published yet (Email › Lead magnet › Delivery).'
        : 'A link goes to your page, but there’s no website or published page yet.';
    case 'BAD_LINK':
      return 'A link isn’t a full web address (https://…).';
    case 'IMAGE_EMPTY':
      return 'An image block has no picture yet: it’s left out.';
    case 'OFFER_EMPTY':
      return 'An offer card has no offer chosen yet: it’s left out.';
    case 'BUTTON_NO_LABEL':
      return 'A button has no label: it’s left out.';
    case 'IMAGE_NOT_HOSTED':
      return 'Upload this image in the email studio first: images in emails have to be hosted by the app.';
    case 'NO_UNSUBSCRIBE_TAG':
      return 'Add your email tool’s unsubscribe link where the footer says so before you send.';
    case 'CUSTOM_TOO_LARGE':
      return 'A custom HTML block is too big and was left out.';
    default:
      return '';
  }
}

/** The renderer's warnings, plus a predicted IMAGE_NOT_HOSTED, as plain sentences (each once). */
export function warningLines(warnings: string[], doc?: EmailDoc): string[] {
  const codes = [...warnings, ...(doc && !__ARTIFACT_BUILD__ && unhostedImages(doc).length ? ['IMAGE_NOT_HOSTED'] : [])];
  return [...new Set(codes.map(warningText).filter(Boolean))];
}

type Device = 'desktop' | 'phone';

/** The iframe and its chrome. html: the rendered email. */
export function EmailFrame({
  html,
  subject,
  from,
  to,
  warnings = [],
  className,
  compact,
}: {
  html: string;
  subject: string;
  from?: string;
  to?: string;
  warnings?: string[];
  className?: string;
  compact?: boolean;
}) {
  const [device, setDevice] = useState<Device>('desktop');
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      {!compact && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-small">
            {from && (
              <p className="truncate text-muted">
                <span className="text-faint">From</span> {from}
                {to && (
                  <>
                    {' '}
                    <span className="text-faint">to</span> {to}
                  </>
                )}
              </p>
            )}
            <p className="truncate font-semibold text-ink">{subject}</p>
          </div>
          <Segmented<Device>
            size="sm"
            aria-label="Preview width"
            value={device}
            onChange={setDevice}
            options={[
              { id: 'desktop', label: 'Desktop', icon: <Monitor /> },
              { id: 'phone', label: 'Phone', icon: <Smartphone /> },
            ]}
          />
        </div>
      )}
      <div className="overflow-x-auto rounded-md border border-line bg-surface-2">
        <iframe
          sandbox={FRAME_SANDBOX}
          srcDoc={html}
          title={`Email preview: ${subject}`}
          className={cn('mx-auto block h-[640px] border-0 bg-surface', compact && 'h-[360px]')}
          style={{
            width: device === 'phone' ? 375 : '100%',
            minWidth: device === 'phone' ? 375 : 320,
            maxWidth: '100%',
          }}
        />
      </div>
      {warnings.length > 0 && (
        <Callout tone="warn">
          <ul className="flex flex-col gap-1">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}

/** One email (or a doc in progress, or version B's) rendered for the preview, in its frame. */
export function EmailPreview({ project, step, doc, subject, compact, className }: { project: Project; step: EmailStep; doc?: EmailDoc; subject?: string; compact?: boolean; className?: string }) {
  const tokens = emailTokens(project);
  const out = useMemo(() => {
    try {
      const r = emailHtml(step, project, 'preview', { doc, subject });
      return {
        html: r.html,
        warnings: warningLines(r.warnings, doc ?? step.doc),
      };
    } catch (e) {
      const big = e instanceof RenderError && e.code === 'TOO_LARGE';
      return {
        html: '',
        warnings: [big ? 'This email is too large to send (over 200 KB). Remove a block or a custom HTML block.' : 'This email couldn’t be shown. Undo the last change.'],
      };
    }
    // the project's brand and links count too
  }, [step, project, doc, subject]);
  return (
    <EmailFrame
      html={out.html}
      subject={renderTokens(subject ?? step.subject, tokens)}
      from={`${project.brand.name} <${tokens.sender_email}>`}
      to={tokens.email}
      warnings={out.warnings}
      compact={compact}
      className={className}
    />
  );
}
