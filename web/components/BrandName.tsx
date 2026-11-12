/** Render the registration mark as a superscript while preserving plain-text names. */
export function BrandName({ name }: { name: string }) {
  const mark = name.indexOf('®')
  if (mark === -1) return <>{name}</>

  return (
    <span className="whitespace-nowrap">
      {name.slice(0, mark)}
      <sup className="relative -top-[0.5em] align-baseline text-[0.5em] leading-none">®</sup>
      {name.slice(mark + 1)}
    </span>
  )
}
