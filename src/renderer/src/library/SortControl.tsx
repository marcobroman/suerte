import { ALBUM_SORT_OPTIONS, type AlbumSortDir, type AlbumSortKey } from './view'

export interface SortControlProps {
  readonly sortKey: AlbumSortKey
  readonly sortDir: AlbumSortDir
  readonly options?: readonly { readonly id: AlbumSortKey; readonly label: string }[]
  onKeyChange(key: AlbumSortKey): void
  onDirToggle(): void
}

/** Album tile ordering for the grid pages. Year direction flips; unknown years stay last. */
export function SortControl({
  sortKey,
  sortDir,
  options = ALBUM_SORT_OPTIONS,
  onKeyChange,
  onDirToggle
}: SortControlProps) {
  const ascending = sortDir === 'asc'
  return (
    <div className="sort-row">
      <label className="sort-label" htmlFor="album-sort">
        Sort
      </label>
      <select
        id="album-sort"
        className="sort-select"
        value={sortKey}
        onChange={(event) => onKeyChange(event.target.value as AlbumSortKey)}
        aria-label="Sort albums"
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="sort-dir"
        onClick={onDirToggle}
        aria-label={ascending ? 'Sort descending' : 'Sort ascending'}
        title={ascending ? 'Sort descending' : 'Sort ascending'}
      >
        {ascending ? '↑' : '↓'}
      </button>
    </div>
  )
}
