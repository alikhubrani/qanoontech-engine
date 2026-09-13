import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type AuditEntry, type AuditKind } from '../api'
import { S } from '../strings'
import { exact, when } from '@/lib/time'
import { auditKindTone } from '@/lib/tones'
import { Empty, Note, Page, PageHeader, Row, Rows } from '@/components/page'
import { Pill } from '@/components/ui/pill'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'

type Filter = 'notable' | AuditKind | 'all'

const FILTERS: { id: Filter; label: string; kinds?: AuditKind[] }[] = [
  { id: 'notable', label: S.filterNotable, kinds: ['security', 'change', 'failure'] },
  { id: 'security', label: S.auditKind.security, kinds: ['security'] },
  { id: 'change', label: S.auditKind.change, kinds: ['change'] },
  { id: 'failure', label: S.auditKind.failure, kinds: ['failure'] },
  { id: 'routine', label: S.auditKind.routine, kinds: ['routine'] },
  { id: 'all', label: S.filterAll },
]

const PAGE = 50

/**
 * The whole trail, paged by timestamp. The overview shows the notable few;
 * this is for the day somebody asks "who restarted the system on the 14th".
 */
export function Activity() {
  const [filter, setFilter] = useState<Filter>('notable')
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (before?: string) => {
      setBusy(true)
      setError(null)
      try {
        const kinds = FILTERS.find((f) => f.id === filter)?.kinds
        const params = new URLSearchParams({ limit: String(PAGE) })
        if (kinds) params.set('kinds', kinds.join(','))
        if (before) params.set('before', before)
        const data = await api.get<{ entries: AuditEntry[]; more: boolean }>(`/api/audit?${params}`)
        setEntries((current) => (before && current ? [...current, ...data.entries] : data.entries))
        setMore(data.more)
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : S.errorGeneric)
      } finally {
        setBusy(false)
      }
    },
    [filter],
  )

  useEffect(() => {
    setEntries(null)
    void load()
  }, [load])

  return (
    <Page>
      <PageHeader title={S.navActivity} description={S.activityPageExplainer}>
        <Tabs value={filter} onValueChange={(next) => setFilter(next as Filter)}>
          <TabsList>
            {FILTERS.map((f) => (
              <TabsTrigger key={f.id} value={f.id}>
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </PageHeader>

      {error && <Note tone="destructive">{error}</Note>}

      {entries === null ? null : entries.length === 0 ? (
        <Empty>{S.auditEmpty}</Empty>
      ) : (
        <div className="space-y-4">
          <Rows>
            {entries.map((entry, index) => (
              <Row key={`${entry.at}-${index}`}>
                <Pill tone={auditKindTone(entry.kind)} size="sm" className="w-16 justify-center">
                  {S.auditKind[entry.kind]}
                </Pill>
                <div className="min-w-0 flex-1">
                  <span className="text-sm">{entry.label}</span>
                  {entry.detail && <span className="text-sm text-muted-foreground"> — {entry.detail}</span>}
                  <div className="text-xs text-muted-foreground">
                    {[entry.subject, entry.address].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <time dateTime={entry.at} title={exact(entry.at)} className="shrink-0 text-xs text-muted-foreground">
                  {when(entry.at)}
                </time>
              </Row>
            ))}
          </Rows>
          {more && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(entries.at(-1)?.at)}>
              {busy ? S.workingEllipsis : S.activityOlder}
            </Button>
          )}
        </div>
      )}
    </Page>
  )
}
