import { useMemo, useState } from 'react'
import type { DiscogsCandidate, DiscogsRelease, TagWriteResult } from '@shared/types'
import type { DiscogsFailure } from '@shared/ipc'
import {
  describeTagError,
  editsForReleaseTrack,
  mapReleaseToFiles,
  type AutoTagFile
} from './autotag'

export interface AutoTagDialogProps {
  /** MP3-only files; anything else was filtered before opening. */
  readonly files: readonly AutoTagFile[]
  /** Non-MP3 files left out, so the dialog can say so. */
  readonly skipped: number
  readonly initialQuery: string
  onClose(): void
}

type Stage = 'query' | 'candidates' | 'preview' | 'applying' | 'done'

function friendlyDiscogsError(error: DiscogsFailure): string {
  switch (error.kind) {
    case 'missing-token':
      return 'Add a Discogs personal token in Settings ⚙ to enable auto-tag.'
    case 'unauthorized':
      return 'Discogs rejected the token — check it in Settings ⚙.'
    case 'rate-limited':
      return 'Discogs rate limit hit — try again shortly.'
    case 'not-found':
      return 'Not found on Discogs.'
    default:
      return error.message
  }
}

function shortName(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(slash + 1)
}

/** Search Discogs → pick a release → preview the mapping → apply to MP3s. */
export function AutoTagDialog({ files, skipped, initialQuery, onClose }: AutoTagDialogProps) {
  const [stage, setStage] = useState<Stage>('query')
  const [query, setQuery] = useState(initialQuery)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<readonly DiscogsCandidate[]>([])
  const [release, setRelease] = useState<DiscogsRelease | null>(null)
  const [confirmMismatch, setConfirmMismatch] = useState(false)
  const [artNote, setArtNote] = useState<string | null>(null)
  const [results, setResults] = useState<readonly TagWriteResult[] | null>(null)

  const mapping = useMemo(
    () => (release ? mapReleaseToFiles(files, release) : null),
    [files, release]
  )
  const mismatch = release !== null && files.length !== release.tracks.length
  const failed = results?.filter((result) => !result.ok) ?? []

  const search = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const outcome = await window.equalizer.searchDiscogs(query)
      if (!outcome.ok) {
        setError(friendlyDiscogsError(outcome.error))
        return
      }
      setCandidates(outcome.candidates)
      setStage('candidates')
    } finally {
      setBusy(false)
    }
  }

  const pick = async (candidate: DiscogsCandidate): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const outcome = await window.equalizer.getDiscogsRelease(candidate.id, candidate.kind)
      if (!outcome.ok) {
        setError(friendlyDiscogsError(outcome.error))
        return
      }
      setRelease(outcome.release)
      setConfirmMismatch(false)
      setStage('preview')
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (!release || !mapping) return
    setBusy(true)
    setStage('applying')
    try {
      let art: { mime: string; data: Uint8Array } | undefined = undefined
      if (release.coverUrl) {
        const downloaded = await window.equalizer.fetchDiscogsArt(release.coverUrl)
        if (downloaded.ok) {
          art = downloaded.art
          setArtNote(null)
        } else {
          setArtNote('Cover unavailable — fields still applied.')
        }
      }
      const outcome = await window.equalizer.updateTags(
        mapping.pairs.map((pair) => ({
          path: pair.file.path,
          edits: editsForReleaseTrack(release, pair, art)
        }))
      )
      setResults(outcome.results)
      setStage('done')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="Auto-tag from Discogs">
        <header className="modal-head">
          <h2>Auto-tag from Discogs</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close auto-tag">
            ✕
          </button>
        </header>

        <div className="modal-body">
          {files.length === 0 ? (
            <p className="empty">Nothing taggable here — auto-tag supports MP3 files.</p>
          ) : (
            <>
              <p className="modal-sub">
                {files.length} {files.length === 1 ? 'file' : 'files'}
                {skipped > 0 &&
                  ` · ${skipped} skipped (MP3 only)`}
                {stage !== 'query' && (
                  <>
                    {' · '}
                    <button type="button" className="link-button" onClick={() => setStage('query')}>
                      New search
                    </button>
                  </>
                )}
              </p>

              {(stage === 'query' || stage === 'candidates') && (
                <div className="autotag-search">
                  <input
                    className="search autotag-input"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void search()
                    }}
                    aria-label="Discogs search"
                    placeholder="Artist and album"
                    autoFocus
                  />
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy || query.trim() === ''}
                    onClick={() => void search()}
                  >
                    {busy ? 'Searching…' : 'Search'}
                  </button>
                </div>
              )}

              {error !== null && (
                <p className="modal-error" role="alert">
                  {error}
                </p>
              )}

              {stage === 'candidates' && (
                <ol className="candidate-list">
                  {candidates.length === 0 && !busy && (
                    <li>
                      <p className="empty">No releases found. Try a different search.</p>
                    </li>
                  )}
                  {candidates.map((candidate) => (
                    <li key={`${candidate.kind}-${candidate.id}`}>
                      <button
                        type="button"
                        className="candidate-row"
                        disabled={busy}
                        onClick={() => void pick(candidate)}
                      >
                        {candidate.thumbUrl ? (
                          <img
                            className="candidate-thumb"
                            src={candidate.thumbUrl}
                            alt=""
                            loading="lazy"
                            // Remote Discogs art: no referrer leaks the page
                            // URL, and scripts never run from <img>.
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span className="candidate-thumb empty-thumb" aria-hidden="true" />
                        )}
                        <span className="candidate-text">
                          <span className="candidate-title">
                            {candidate.artist !== '' ? `${candidate.artist} – ` : ''}
                            {candidate.title}
                          </span>
                          <span className="candidate-meta">
                            {candidate.year ?? '—'}
                            {candidate.label !== '' ? ` · ${candidate.label}` : ''} ·{' '}
                            {candidate.kind === 'master' ? 'Master' : 'Release'}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}

              {(stage === 'preview' || stage === 'applying' || stage === 'done') &&
                release !== null &&
                mapping !== null && (
                  <>
                    <div className="release-head">
                      {release.coverUrl ? (
                        <img
                          className="release-cover"
                          src={release.coverUrl}
                          alt=""
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <span className="release-cover empty-thumb" aria-hidden="true" />
                      )}
                      <div>
                        <p className="release-title">
                          {release.artist !== '' ? `${release.artist} – ` : ''}
                          {release.title}
                        </p>
                        <p className="release-meta">
                          {release.year ?? '—'}
                          {release.label !== '' ? ` · ${release.label}` : ''} ·{' '}
                          {release.tracks.length}{' '}
                          {release.tracks.length === 1 ? 'track' : 'tracks'}
                        </p>
                      </div>
                    </div>

                    <p className="modal-sub">
                      Every file takes the artist, album{release.year !== null ? ', year' : ''} and
                      cover{release.coverUrl ? '' : ' (none on Discogs)'}; titles and track numbers
                      follow the list order.
                    </p>

                    {mismatch && (
                      <div className="mismatch" role="alert">
                        <p>
                          {files.length} {files.length === 1 ? 'file' : 'files'} but{' '}
                          {release.tracks.length} release{' '}
                          {release.tracks.length === 1 ? 'track' : 'tracks'} — mapping follows the
                          order; extras on either side are left alone.
                        </p>
                        <label className="mismatch-confirm">
                          <input
                            type="checkbox"
                            checked={confirmMismatch}
                            onChange={(event) => setConfirmMismatch(event.target.checked)}
                          />{' '}
                          Apply anyway
                        </label>
                      </div>
                    )}

                    {mapping.unmappedFiles.length > 0 && (
                      <p className="modal-sub">
                        Unmapped files: {mapping.unmappedFiles.map((entry) => shortName(entry.path)).join(', ')}
                      </p>
                    )}

                    <ol className="mapping-list">
                      {mapping.pairs.map((pair) => (
                        <li key={pair.file.path} className="mapping-row">
                          <span className="mapping-number">{pair.index + 1}</span>
                          <span className="mapping-text">
                            <span className="mapping-old" title={pair.file.title}>
                              {pair.file.title}
                            </span>
                            <span className="mapping-arrow" aria-hidden="true">
                              →
                            </span>
                            <span className="mapping-new" title={pair.discogsTitle}>
                              {pair.discogsTitle}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ol>

                    {stage === 'preview' && (
                      <div className="album-actions">
                        <button
                          type="button"
                          className="primary-button"
                          disabled={busy || (mismatch && !confirmMismatch)}
                          onClick={() => void apply()}
                        >
                          Apply to {mapping.pairs.length}{' '}
                          {mapping.pairs.length === 1 ? 'file' : 'files'}
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => setStage('candidates')}
                        >
                          Back to results
                        </button>
                      </div>
                    )}

                    {stage === 'applying' && <p className="modal-sub">Writing tags…</p>}

                    {stage === 'done' && (
                      <>
                        {artNote !== null && <p className="modal-sub">{artNote}</p>}
                        <ol className="mapping-list">
                          {(results ?? []).map((result, index) => {
                            const pair = mapping.pairs[index]
                            const name = pair?.file.title ?? shortName(result.path)
                            return (
                              <li key={result.path} className="mapping-row">
                                <span aria-hidden="true">{result.ok ? '✓' : '✗'}</span>
                                <span className="mapping-text">
                                  <span className="mapping-old">{name}</span>
                                  {!result.ok && result.error && (
                                    <span className="modal-error">
                                      {describeTagError(result.error.kind)}
                                    </span>
                                  )}
                                </span>
                              </li>
                            )
                          })}
                        </ol>
                        {failed.length === 0 ? (
                          <p className="modal-sub">All tags updated — the library refreshes itself.</p>
                        ) : (
                          <p className="modal-error" role="alert">
                            {failed.length} of {results?.length ?? 0} failed; the rest applied.
                          </p>
                        )}
                        <div className="album-actions">
                          <button type="button" className="primary-button" onClick={onClose}>
                            Done
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}
            </>
          )}
        </div>

        <footer className="modal-foot">
          <span>Metadata from Discogs</span>
        </footer>
      </div>
    </div>
  )
}
