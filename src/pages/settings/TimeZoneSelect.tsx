import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { browserTimeZone, isValidTimeZone, timeZoneLabel, timeZoneNames, timeZoneSearchValue, utcOffsetLabel } from '@/lib/timeZone';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shadcn/popover';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/shadcn/command';

/**
 * A searchable list of IANA time zones (type a city, a region or an offset). Only names this browser knows can
 * be chosen; a saved zone it doesn't know is shown as it is and kept until the owner picks another.
 */
export function TimeZoneSelect({ value, onChange, id }: { value: string; onChange: (tz: string) => void; id?: string }) {
  const [open, setOpen] = useState(false);
  const here = useMemo(() => browserTimeZone(), []);
  // offsets are worked out once per opening (they change with daylight saving, not while the list is open)
  const options = useMemo(() => {
    if (!open) return [];
    const now = Date.now();
    return timeZoneNames([value, here]).map((tz) => ({ tz, label: timeZoneLabel(tz), offset: utcOffsetLabel(tz, now) }));
  }, [open, value, here]);
  const known = isValidTimeZone(value);
  const choose = (tz: string) => {
    if (isValidTimeZone(tz)) onChange(tz);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button id={id} type="button" role="combobox" aria-expanded={open} aria-haspopup="listbox" className="input flex w-full items-center gap-2 text-left md:max-w-[420px]">
          <Clock className="size-4 shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{value ? `${timeZoneLabel(value)}${known ? ` · ${utcOffsetLabel(value)}` : ''}` : 'Choose a time zone'}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={8} className="w-[min(420px,calc(100vw-16px))] p-0">
        <Command>
          <CommandInput placeholder="Search a city, region or offset" aria-label="Search time zones" />
          <CommandList className="max-h-72">
            <CommandEmpty>No time zone matches.</CommandEmpty>
            {here !== value && (
              <CommandItem value={`${here} ${timeZoneLabel(here)} this device`} onSelect={() => choose(here)}>
                <span className="min-w-0 flex-1 truncate">This device: {timeZoneLabel(here)}</span>
                <span className="num shrink-0 text-caption text-muted">{utcOffsetLabel(here)}</span>
              </CommandItem>
            )}
            {options.map((o) => (
              <CommandItem key={o.tz} value={timeZoneSearchValue(o.tz, o.label, o.offset)} onSelect={() => choose(o.tz)}>
                <Check className={cn('size-4 shrink-0', o.tz === value ? 'text-primary' : 'invisible')} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <span className="num shrink-0 text-caption text-muted">{o.offset}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
