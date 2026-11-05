import * as React from "react"
import { type DialogProps } from "@radix-ui/react-dialog"
import { Command as CommandPrimitive } from "cmdk"
import { Search } from "lucide-react"

import { cn } from "@/components/ui/shadcn/utils"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/shadcn/dialog"

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      "flex h-full w-full flex-col overflow-hidden bg-elevated text-ink",
      className
    )}
    {...props}
  />
))
Command.displayName = CommandPrimitive.displayName

/** The command palette's window: 640px, 12vh from the top (full screen on phones). */
const CommandDialog = ({
  children,
  title = "Command palette",
  commandProps,
  onCloseAutoFocus,
  ...props
}: DialogProps & {
  title?: string
  commandProps?: React.ComponentPropsWithoutRef<typeof CommandPrimitive>
  /** Where the focus goes on close (the palette has no DialogTrigger to hand it back to). */
  onCloseAutoFocus?: (e: Event) => void
}) => {
  return (
    <Dialog {...props}>
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={onCloseAutoFocus}
        className="inset-0 z-palette flex flex-col overflow-hidden bg-elevated shadow-dialog data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=closed]:zoom-out-[0.97] data-[state=open]:duration-240 data-[state=closed]:duration-150 sm:inset-auto sm:inset-x-0 sm:top-[12vh] sm:mx-auto sm:max-h-[min(560px,76vh)] sm:w-[calc(100vw-32px)] sm:max-w-[640px] sm:rounded-stage sm:border sm:border-line dark:sm:border-line-2"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <Command
          {...commandProps}
          className={cn(
            "min-h-0 flex-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-muted",
            commandProps?.className
          )}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input> & { trailing?: React.ReactNode }
>(({ className, trailing, ...props }, ref) => (
  <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4" cmdk-input-wrapper="">
    <Search className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden="true" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "flex h-full w-full bg-transparent text-body-lg text-ink outline-none placeholder:text-muted disabled:cursor-not-allowed",
        className
      )}
      {...props}
    />
    {trailing}
  </div>
))

CommandInput.displayName = CommandPrimitive.Input.displayName

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn("scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-1.5 sm:max-h-[420px]", className)}
    {...props}
  />
))

CommandList.displayName = CommandPrimitive.List.displayName

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className="px-3 py-6 text-center text-small text-muted"
    {...props}
  />
))

CommandEmpty.displayName = CommandPrimitive.Empty.displayName

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      "overflow-hidden py-1 text-ink [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-muted",
      className
    )}
    {...props}
  />
))

CommandGroup.displayName = CommandPrimitive.Group.displayName

const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn("-mx-1.5 my-1 h-px bg-line", className)}
    {...props}
  />
))
CommandSeparator.displayName = CommandPrimitive.Separator.displayName

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex h-10 cursor-default select-none items-center gap-3 rounded-md px-3 text-body text-ink-2 outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-surface-3 data-[selected=true]:text-ink data-[disabled=true]:text-faint",
      className
    )}
    {...props}
  />
))

CommandItem.displayName = CommandPrimitive.Item.displayName

const CommandShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn(
        "ml-auto font-mono text-caption text-muted",
        className
      )}
      {...props}
    />
  )
}
CommandShortcut.displayName = "CommandShortcut"

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
