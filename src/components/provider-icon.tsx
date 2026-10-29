import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"
import { browser } from "#imports"
import { cn } from "@/utils/styles/utils"

const providerIconVariants = cva("flex min-w-0 items-center", {
  variants: {
    size: {
      sm: "gap-1.5",
      base: "gap-2",
      md: "gap-3",
      lg: "gap-4",
      xl: "gap-5",
    },
  },
  defaultVariants: {
    size: "base",
  },
})

const iconContainerVariants = cva(
  "flex flex-shrink-0 items-center justify-center rounded-full border border-border bg-white dark:bg-muted",
  {
    variants: {
      size: {
        sm: "size-5",
        base: "size-6",
        md: "size-8",
        lg: "size-10",
        xl: "size-12",
      },
    },
    defaultVariants: {
      size: "base",
    },
  },
)

const iconVariants = cva("", {
  variants: {
    size: {
      sm: "size-[11px]",
      base: "size-3.5",
      md: "size-5",
      lg: "size-6",
      xl: "size-7",
    },
  },
  defaultVariants: {
    size: "base",
  },
})

const textVariants = cva("truncate", {
  variants: {
    size: {
      sm: "text-sm",
      base: "text-base",
      md: "text-md",
      lg: "text-lg",
      xl: "text-xl",
    },
  },
  defaultVariants: {
    size: "base",
  },
})

interface ProviderIconProps extends VariantProps<typeof providerIconVariants> {
  logo: string
  name?: string
  className?: string
  textClassName?: string
}

const PROTOCOL_RELATIVE_URL_RE = /^(?:[a-z][a-z\d+\-.]*:)?\/\//i
const SCHEME_URL_RE = /^[a-z][a-z\d+\-.]*:/i

function normalizeLogoUrl(logo: string) {
  if (PROTOCOL_RELATIVE_URL_RE.test(logo) || SCHEME_URL_RE.test(logo)) {
    return logo
  }

  try {
    return new URL(logo, browser.runtime.getURL("/")).href
  } catch {
    return logo
  }
}

export default function ProviderIcon({
  logo,
  name,
  size,
  className,
  textClassName,
}: ProviderIconProps) {
  return (
    <div className={cn(providerIconVariants({ size }), className)}>
      <div className={iconContainerVariants({ size })}>
        <img src={normalizeLogoUrl(logo)} alt={name ?? ""} className={iconVariants({ size })} />
      </div>
      {name && <span className={cn(textVariants({ size }), textClassName)}>{name}</span>}
    </div>
  )
}
