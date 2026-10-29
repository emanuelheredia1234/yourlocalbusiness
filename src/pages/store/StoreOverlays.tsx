import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BadgeCheck, CalendarCheck, Check, CreditCard, ExternalLink, Lock, MapPin, Minus, Plus, ShoppingCart, Trash2, Clock, Download, MessageSquare } from 'lucide-react';
import type { Order } from '@/lib/types';
import { addDays, cardBrand, cn, combineDateTime, emailValid, expiryValid, fmtDate, fmtDateTime, fmtMoney, formatCardNumber, luhnValid, slugify, todayStr } from '@/lib/utils';
import { recordCommunityOrder } from '@/lib/community';
import { FORMATS } from '@/ai/knowledge';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { Drawer, Field, Modal, Spinner } from '@/components/ui/primitives';
import { MiniMark } from '@/components/brand/Logo';
import { download } from '@/components/ui/download';
import { ListingCover, priceLabel, Stars } from './ListingParts';
import { findListing } from './useListings';
import { accessFile, addListingToCart } from './actions';

function ListingModal() {
  const id = useUI((s) => s.listingId);
  const open = useUI((s) => s.openListing);
  const setCheckout = useUI((s) => s.setCheckoutOpen);
  const l = useMemo(() => findListing(id), [id]);
  const [svc, setSvc] = useState(0);
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [msg, setMsg] = useState('');
  const [email, setEmail] = useState(useStore.getState().settings.profile.email);
  const [sent, setSent] = useState(false);
  const [view, setView] = useState(0);
  useEffect(() => {
    setView(0);
    setSvc(0);
    setDay('');
    setTime('');
    setMsg('');
    setSent(false);
  }, [id]);
  if (!id || !l) return null;
  const close = () => open(null);
  const isBiz = l.kind === 'business';
  const services = l.services ?? [];
  const chosen = services[svc];
  const days = Array.from({ length: 10 }, (_, i) => addDays(todayStr(), i + 1));
  const times = ['9:00', '10:30', '12:00', '13:30', '15:00', '16:30'];
  const price = chosen ? chosen.price : l.price;

  const add = (thenCheckout: boolean) => {
    if (isBiz && l.bookingType === 'book' && (!day || !time)) {
      toast({ kind: 'info', title: 'Pick a day and time for your booking' });
      return;
    }
    addListingToCart(l, { option: chosen?.name, price, bookingAt: isBiz && l.bookingType === 'book' && day && time ? combineDateTime(day, time) : undefined });
    if (thenCheckout) {
      close();
      setCheckout(true);
    }
  };

  return (
    <Modal open onClose={close} size="lg" bodyClass="p-0">
      <div className="relative">
        {view > 0 && l.gallery?.[view - 1] ? (
          <div className="flex aspect-[21/8] w-full items-center justify-center bg-surface-3">
            <img src={l.gallery[view - 1]} alt={`${l.title}: image ${view + 1}`} className="h-full w-full object-contain" />
          </div>
        ) : (
          <ListingCover listing={l} big className="aspect-[21/8] w-full" />
        )}
        <div className="absolute left-3 top-3 flex gap-1">
          {l.origin === 'sample' && <span className="badge bg-black/45 text-white">Sample listing</span>}
          {l.origin === 'mine' && <span className="badge bg-accent text-on-accent">Your listing</span>}
          {l.origin === 'community' && <span className="badge bg-info text-white">Community seller</span>}
        </div>
      </div>
      {!!l.gallery?.length && (
        <div className="scroll-thin flex gap-2 overflow-x-auto border-b border-line px-5 py-2.5" role="tablist" aria-label="Listing images">
          {[l.cover.imageDataUrl ?? '', ...l.gallery].map((src, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={view === i}
              aria-label={i === 0 ? 'Cover' : `Image ${i + 1}`}
              className={cn('h-14 w-20 shrink-0 overflow-hidden rounded-md ring-offset-2 ring-offset-surface', view === i ? 'ring-2 ring-primary' : 'ring-1 ring-line hover:ring-line-2')}
              onClick={() => setView(i)}
            >
              {i === 0 && !src ? <ListingCover listing={l} className="h-full w-full" /> : <img src={src} alt="" className="h-full w-full object-cover" />}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 p-5 md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <MiniMark logo={l.seller.logo} name={l.seller.name} size={24} />
            <span className="text-[13px] font-semibold">{l.seller.name}</span>
            {l.seller.verified && <BadgeCheck size={14} className="text-info" />}
          </div>
          <h2 className="font-display text-[24px] font-bold leading-tight tracking-[-0.01em]">{l.title}</h2>
          <p className="mt-1 text-[14px] text-ink-2">{l.tagline}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
            <Stars rating={l.rating} reviews={l.reviews} />
            <span className="num">{l.sales.toLocaleString()} {isBiz ? 'customers' : 'sold'}</span>
            {isBiz && l.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} /> {l.location.city}
                {l.location.region ? `, ${l.location.region}` : ''}
                {l.location.online && l.location.city !== 'Online' ? ' · also online' : ''}
              </span>
            )}
            {!isBiz && l.format && <span>{FORMATS[l.format].label}</span>}
          </div>
          <p className="mt-4 whitespace-pre-line text-[14px] leading-relaxed text-ink-2">{l.description}</p>
          {l.includes && l.includes.length > 0 && (
            <div className="mt-4">
              <p className="eyebrow mb-2">What’s included</p>
              <ul className="flex flex-col gap-1.5 text-[13.5px]">
                {l.includes.map((i) => (
                  <li key={i} className="flex gap-2">
                    <Check size={15} className="mt-0.5 shrink-0 text-primary" /> {i}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {isBiz && (
            <div className="mt-4 flex flex-wrap gap-4 text-[13px] text-ink-2">
              {l.hours && (
                <span className="inline-flex items-center gap-1.5">
                  <Clock size={14} /> {l.hours}
                </span>
              )}
              {l.website && (
                <a className="inline-flex items-center gap-1.5 text-primary hover:underline" href={l.website} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={14} /> Website
                </a>
              )}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-1.5">
            {l.tags.map((t) => (
              <span key={t} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-ink-2">
                #{t.replace(/\s+/g, '')}
              </span>
            ))}
          </div>
        </div>

        <aside className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2/50 p-4 md:self-start">
          <p className="num font-display text-[26px] font-bold">{priceLabel(price, chosen ? (l.bookingType === 'buy' ? 'one-time' : l.priceModel) : l.priceModel)}</p>
          {services.length > 0 && (
            <Field label={isBiz ? 'Service' : 'Option'} htmlFor="svc">
              <select id="svc" className="select" value={svc} onChange={(e) => setSvc(Number(e.target.value))}>
                {services.map((s, i) => (
                  <option key={s.name} value={i}>
                    {s.name} · {s.price ? fmtMoney(s.price) : 'Free'}
                    {s.duration ? ` · ${s.duration}` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {isBiz && l.bookingType === 'book' && (
            <>
              <Field label="Day">
                <div className="flex flex-wrap gap-1.5">
                  {days.map((d) => (
                    <button key={d} type="button" className={cn('chip', day === d && 'chip-active')} onClick={() => setDay(d)}>
                      {fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Time">
                <div className="flex flex-wrap gap-1.5">
                  {times.map((t) => (
                    <button key={t} type="button" className={cn('chip', time === t && 'chip-active')} onClick={() => setTime(t)} disabled={!day}>
                      {t}
                    </button>
                  ))}
                </div>
              </Field>
            </>
          )}
          {isBiz && l.bookingType === 'inquire' ? (
            sent ? (
              <div className="rounded-md bg-good-soft p-3 text-[13px] text-good">
                <p className="font-semibold">Inquiry recorded</p>
                <p className="mt-0.5 text-xs">{l.origin === 'sample' ? 'This is a sample listing, so no message is delivered.' : `${l.seller.name} will reply to ${email}.`}</p>
              </div>
            ) : (
              <>
                <Field label="Your email" htmlFor="inq-email">
                  <input id="inq-email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
                </Field>
                <Field label="Message" htmlFor="inq-msg">
                  <textarea id="inq-msg" className="textarea" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={`Hi! I’m interested in ${chosen?.name ?? l.title}…`} />
                </Field>
                <button
                  className="btn btn-primary"
                  disabled={!emailValid(email) || !msg.trim()}
                  onClick={() => {
                    setSent(true);
                    useStore.getState().notify({ kind: 'info', title: `Inquiry sent to ${l.seller.name}`, body: msg.slice(0, 80) });
                  }}
                >
                  <MessageSquare size={15} /> Send inquiry
                </button>
                {services.length > 0 && (
                  <button className="btn btn-secondary" onClick={() => add(false)}>
                    <ShoppingCart size={15} /> Pay a deposit instead
                  </button>
                )}
              </>
            )
          ) : (
            <>
              <button className="btn btn-primary" onClick={() => add(true)}>
                {isBiz && l.bookingType === 'book' ? <CalendarCheck size={15} /> : <CreditCard size={15} />} {isBiz && l.bookingType === 'book' ? 'Book & pay' : 'Buy now'}
              </button>
              <button className="btn btn-secondary" onClick={() => add(false)}>
                <ShoppingCart size={15} /> Add to cart
              </button>
            </>
          )}
          <p className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <Lock size={11} /> Secure demo checkout. No real payment is taken.
          </p>
        </aside>
      </div>
    </Modal>
  );
}

function CartDrawer() {
  const open = useUI((s) => s.cartOpen);
  const setOpen = useUI((s) => s.setCartOpen);
  const setCheckout = useUI((s) => s.setCheckoutOpen);
  const cart = useStore((s) => s.cart);
  const setQty = useStore((s) => s.setCartQty);
  const remove = useStore((s) => s.removeFromCart);
  const subtotal = cart.reduce((n, c) => n + c.price * c.qty, 0);
  return (
    <Drawer
      open={open}
      onClose={() => setOpen(false)}
      title={`Your cart (${cart.reduce((n, c) => n + c.qty, 0)})`}
      footer={
        cart.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex justify-between text-[14px]">
              <span className="text-muted">Subtotal</span>
              <b className="num">{fmtMoney(subtotal, { cents: true })}</b>
            </div>
            <button
              className="btn btn-primary btn-lg w-full"
              onClick={() => {
                setOpen(false);
                setCheckout(true);
              }}
            >
              <Lock size={16} /> Checkout
            </button>
          </div>
        )
      }
    >
      {cart.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <ShoppingCart size={28} className="text-faint" />
          <p className="font-semibold">Your cart is empty</p>
          <p className="text-[13px] text-muted">Browse the marketplace to find products and services.</p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {cart.map((c) => (
            <li key={c.id} className="flex gap-3 py-3">
              <ListingCover listing={{ cover: c.cover } as never} className="h-16 w-20 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-semibold">{c.title}</p>
                <p className="truncate text-xs text-muted">
                  {c.sellerName}
                  {c.option ? ` · ${c.option}` : ''}
                </p>
                {c.bookingAt && <p className="text-xs font-medium text-primary">{fmtDateTime(c.bookingAt)}</p>}
                <div className="mt-1.5 flex items-center gap-2">
                  {c.kind === 'business' ? (
                    <span className="inline-flex items-center rounded-md border border-line">
                      <button className="p-1.5 hover:bg-surface-2" onClick={() => setQty(c.id, c.qty - 1)} aria-label="Decrease quantity">
                        <Minus size={12} />
                      </button>
                      <span className="num w-6 text-center text-[13px]">{c.qty}</span>
                      <button className="p-1.5 hover:bg-surface-2" onClick={() => setQty(c.id, c.qty + 1)} aria-label="Increase quantity">
                        <Plus size={12} />
                      </button>
                    </span>
                  ) : (
                    <span className="text-xs text-muted">Digital · qty 1</span>
                  )}
                  <button className="ml-auto rounded p-1.5 text-muted hover:bg-bad-soft hover:text-bad" onClick={() => remove(c.id)} aria-label={`Remove ${c.title}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <span className="num shrink-0 text-[13.5px] font-semibold">{fmtMoney(c.price * c.qty, { cents: true })}</span>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

function CheckoutModal() {
  const open = useUI((s) => s.checkoutOpen);
  const setOpen = useUI((s) => s.setCheckoutOpen);
  const cart = useStore((s) => s.cart);
  const profile = useStore((s) => s.settings.profile);
  const placeOrder = useStore((s) => s.placeOrder);
  const [step, setStep] = useState<'contact' | 'payment' | 'processing' | 'done'>('contact');
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [method, setMethod] = useState<'card' | 'apple' | 'google' | 'paypal'>('card');
  const [card, setCard] = useState('');
  const [exp, setExp] = useState('');
  const [cvc, setCvc] = useState('');
  const [zip, setZip] = useState('');
  const [touched, setTouched] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  useEffect(() => {
    if (open) {
      setStep('contact');
      setTouched(false);
      setOrder(null);
    }
  }, [open]);
  if (!open) return null;
  const subtotal = cart.reduce((n, c) => n + c.price * c.qty, 0);
  const fees = subtotal > 0 ? Math.round((subtotal * 0.029 + 0.3) * 100) / 100 : 0;
  const total = subtotal + fees;
  const brand = cardBrand(card);
  const cardOk = luhnValid(card);
  const expOk = expiryValid(exp);
  const cvcOk = /^\d{3,4}$/.test(cvc);
  const payOk = method !== 'card' || (cardOk && expOk && cvcOk && zip.trim().length >= 3);
  const close = () => setOpen(false);

  const pay = async () => {
    setTouched(true);
    if (!payOk) return;
    setStep('processing');
    await new Promise((r) => setTimeout(r, 1400));
    const o = placeOrder({ items: cart, subtotal, fees, total, email, name, paymentMethod: method === 'card' ? brand[0].toUpperCase() + brand.slice(1) : method === 'apple' ? 'Apple Pay' : method === 'google' ? 'Google Pay' : 'PayPal', last4: method === 'card' ? card.replace(/\D/g, '').slice(-4) : undefined });
    recordCommunityOrder(o);
    useStore.getState().notify({ kind: 'sale', title: `Order ${o.number} confirmed`, body: `${o.items.length} item${o.items.length > 1 ? 's' : ''} · ${fmtMoney(o.total, { cents: true })}`, route: 'store' });
    setOrder(o);
    setStep('done');
  };

  return (
    <Modal
      open
      onClose={close}
      size="md"
      persistent={step === 'processing'}
      title={step === 'done' ? 'Order confirmed' : 'Checkout'}
      subtitle={step === 'done' ? undefined : 'Demo checkout: no real payment is processed. Test card 4242 4242 4242 4242.'}
      icon={<Lock size={18} className="text-primary" />}
    >
      {step === 'done' && order ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col items-center gap-2 py-2 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-good-soft text-good">
              <Check size={28} />
            </span>
            <p className="font-display text-[20px] font-bold">Thanks, {order.name.split(' ')[0] || 'friend'}!</p>
            <p className="text-[13px] text-muted">
              Order <b className="num text-ink">{order.number}</b> · receipt sent to {order.email}
            </p>
          </div>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {order.items.map((it) => (
              <li key={it.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{it.title}</span>
                  <span className="block text-xs text-muted">{it.bookingAt ? `Booked for ${fmtDateTime(it.bookingAt)}` : it.kind === 'product' ? 'Instant digital access' : it.option ?? it.sellerName}</span>
                </span>
                {it.kind === 'product' && (
                  <button
                    className="btn btn-secondary btn-xs"
                    onClick={async () => {
                      await download(`${slugify(it.title)}-access.md`, accessFile(order, it));
                    }}
                  >
                    <Download size={12} /> Access file
                  </button>
                )}
                <span className="num text-[13px] font-semibold">{fmtMoney(it.price * it.qty, { cents: true })}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between text-[14px]">
            <span className="text-muted">Total paid</span>
            <b className="num">{fmtMoney(order.total, { cents: true })}</b>
          </div>
          <button className="btn btn-primary" onClick={close}>
            Done
          </button>
        </div>
      ) : step === 'processing' ? (
        <div className="flex flex-col items-center gap-3 py-12">
          <Spinner size={28} className="text-primary" />
          <p className="font-semibold">Processing payment…</p>
        </div>
      ) : (
        <div className="grid gap-5">
          <div className="rounded-lg border border-line bg-surface-2/50 p-3">
            {cart.map((c) => (
              <div key={c.id} className="flex justify-between gap-3 py-1 text-[13px]">
                <span className="min-w-0 truncate">
                  {c.qty > 1 ? `${c.qty} × ` : ''}
                  {c.title}
                  {c.option ? <span className="text-muted"> · {c.option}</span> : null}
                </span>
                <span className="num shrink-0">{fmtMoney(c.price * c.qty, { cents: true })}</span>
              </div>
            ))}
            <div className="mt-2 flex justify-between border-t border-line pt-2 text-xs text-muted">
              <span>Processing fee</span>
              <span className="num">{fmtMoney(fees, { cents: true })}</span>
            </div>
            <div className="flex justify-between pt-1 text-[14px] font-bold">
              <span>Total</span>
              <span className="num">{fmtMoney(total, { cents: true })}</span>
            </div>
          </div>
          {cart.length === 0 && <p className="text-[13px] text-muted">Your cart is empty.</p>}
          {step === 'contact' ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Full name" htmlFor="co-name">
                  <input id="co-name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Email for receipt" htmlFor="co-email" error={touched && !emailValid(email) ? 'Enter a valid email address.' : undefined}>
                  <input id="co-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
              </div>
              <button
                className="btn btn-primary"
                disabled={!cart.length}
                onClick={() => {
                  setTouched(true);
                  if (name.trim() && emailValid(email)) {
                    setTouched(false);
                    setStep('payment');
                  }
                }}
              >
                Continue to payment
              </button>
            </>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ['apple', 'Apple Pay'],
                    ['google', 'Google Pay'],
                    ['paypal', 'PayPal'],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} className={cn('btn btn-secondary', method === id && 'border-ink bg-surface-2')} onClick={() => setMethod(id)}>
                    {label}
                  </button>
                ))}
              </div>
              <button className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px] font-semibold', method === 'card' ? 'border-primary bg-primary-soft text-primary' : 'border-line')} onClick={() => setMethod('card')}>
                <CreditCard size={16} /> Pay with card
              </button>
              {method === 'card' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Card number" htmlFor="co-card" className="sm:col-span-2" error={touched && !cardOk ? 'That card number doesn’t look right.' : undefined} right={card ? brand.toUpperCase() : undefined}>
                    <input id="co-card" className="input num" inputMode="numeric" autoComplete="cc-number" placeholder="4242 4242 4242 4242" value={card} onChange={(e) => setCard(formatCardNumber(e.target.value))} />
                  </Field>
                  <Field label="Expiry (MM/YY)" htmlFor="co-exp" error={touched && !expOk ? 'Use a future date as MM/YY.' : undefined}>
                    <input
                      id="co-exp"
                      className="input num"
                      inputMode="numeric"
                      autoComplete="cc-exp"
                      placeholder="12/29"
                      value={exp}
                      onChange={(e) => {
                        const d = e.target.value.replace(/\D/g, '').slice(0, 4);
                        setExp(d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d);
                      }}
                    />
                  </Field>
                  <Field label="CVC" htmlFor="co-cvc" error={touched && !cvcOk ? '3 or 4 digits.' : undefined}>
                    <input id="co-cvc" className="input num" inputMode="numeric" autoComplete="cc-csc" placeholder="123" value={cvc} onChange={(e) => setCvc(e.target.value.replace(/\D/g, '').slice(0, 4))} />
                  </Field>
                  <Field label="ZIP / postal code" htmlFor="co-zip" className="sm:col-span-2" error={touched && zip.trim().length < 3 ? 'Add your postal code.' : undefined}>
                    <input id="co-zip" className="input" autoComplete="postal-code" value={zip} onChange={(e) => setZip(e.target.value)} />
                  </Field>
                </div>
              )}
              <div className="flex gap-2">
                <button className="btn btn-secondary" onClick={() => setStep('contact')}>
                  <ArrowLeft size={15} /> Back
                </button>
                <button className="btn btn-primary flex-1" onClick={pay} disabled={!cart.length}>
                  <Lock size={15} /> Pay {fmtMoney(total, { cents: true })}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

export function StoreOverlays() {
  return (
    <>
      <ListingModal />
      <CartDrawer />
      <CheckoutModal />
    </>
  );
}
