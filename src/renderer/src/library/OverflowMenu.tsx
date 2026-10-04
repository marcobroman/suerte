import { useEffect, useId, useRef, useState } from 'react'

export interface OverflowMenuItem {
  readonly label: string
  onSelect(): void
}

export interface OverflowMenuProps {
  readonly ariaLabel: string
  readonly items: readonly OverflowMenuItem[]
  readonly className?: string
}

/** Small ⋯ dropdown used for track and album actions. Closes on select/Escape. */
export function OverflowMenu({ ariaLabel, items, className }: OverflowMenuProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open ])

  return (
    <div ref={wrapRef} className={className ? `menu-wrap ${className}` : 'menu-wrap'}>
      <button
        type="button"
        className="ghost menu-button"
        onClick={() => setOpen((value) => !value)}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={menuId}
        title={ariaLabel}
      >
        ⋯
      </button>
      {open && (
        <div
          id={menuId}
          className="menu-pop"
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false)
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
