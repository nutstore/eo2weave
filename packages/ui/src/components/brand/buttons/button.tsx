import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Design spec: h-10 (40px), padding [10, 20], cornerRadius: 8, gap 8px
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-primary-600 text-white shadow-[0_1px_3px_0_rgba(13,148,136,0.3)] hover:bg-primary-700 dark:bg-primary-700 dark:text-primary-50 dark:shadow-[0_1px_3px_0_rgba(13,148,136,0.2)] dark:hover:bg-primary-600 font-semibold",
        secondary:
          "border border-gray-200 bg-primary-50 text-primary-600 hover:bg-primary-100 dark:border-neutral-700 dark:bg-primary-100/25 dark:text-primary-700 dark:hover:bg-primary-100/40 font-semibold",
        outline:
          "border border-gray-200 bg-transparent text-secondary hover:bg-gray-50 hover:text-primary dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-foreground font-medium",
        ghost:
          "gap-1.5 bg-transparent text-tertiary hover:bg-gray-100 hover:text-primary dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-foreground font-medium",
        danger:
          "border border-danger-border bg-danger-bg text-danger hover:opacity-90 dark:bg-danger-bg/25 dark:text-red-300 font-semibold",
      },
      size: {
        default: "h-10 px-5 text-sm",
        ghost: "h-10 px-4 text-sm", // Ghost has smaller horizontal padding
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

// Design spec: 32x32, cornerRadius: 6
const iconButtonVariants = cva(
  "inline-flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800",
        primary:
          "border border-primary-600 bg-primary-50 text-primary-600 hover:bg-primary-100 dark:border-primary-700 dark:bg-primary-100/25 dark:text-primary-700 dark:hover:bg-primary-100/40",
        danger:
          "border border-danger-border bg-danger-bg text-danger hover:opacity-90 dark:bg-danger-bg/25 dark:text-red-300",
        ghost: "text-tertiary hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800",
        disabled:
          "cursor-not-allowed bg-gray-100 text-muted dark:bg-neutral-800 dark:text-neutral-500",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BrandButtonPropsBase
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "variant"> {
  asChild?: boolean
}

type ButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>
type IconButtonVariant = NonNullable<
  VariantProps<typeof iconButtonVariants>["variant"]
>

/**
 * Discriminated union on `iconButton` so `variant` is always validated
 * against the correct variant set. The two variant sets share some names
 * ("primary", "ghost") with DIFFERENT styles, and "default" only exists
 * for icon buttons — without this union, `<BrandButton variant="default">`
 * type-checked fine and silently rendered an unstyled (padding-less,
 * borderless) regular button.
 */
export type BrandButtonProps =
  | (BrandButtonPropsBase & {
      iconButton?: false | undefined
      variant?: ButtonVariant
    })
  | (BrandButtonPropsBase & {
      iconButton: true
      variant?: IconButtonVariant
    })

const BrandButton = React.memo(React.forwardRef<HTMLButtonElement, BrandButtonProps>(
  ({ className, variant, iconButton, ...props }, ref) => {
  if (iconButton) {
    return (
      <button
        className={cn(
          "h-8 w-8 rounded-md p-0",
          iconButtonVariants({ variant: variant as VariantProps<typeof iconButtonVariants>["variant"] }),
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }

  // Ghost variant uses special size
  const isGhost = variant === "ghost"
  const size = isGhost ? "ghost" : "default"

  return (
    <button
      className={cn(
        "rounded-lg",
        buttonVariants({ variant: variant as VariantProps<typeof buttonVariants>["variant"], size })
      , className)}
      ref={ref}
      {...props}
    />
  )
}))
BrandButton.displayName = "BrandButton"

export { BrandButton, buttonVariants, iconButtonVariants }
