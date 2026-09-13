import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useOverview } from '../overview-context'
import { S } from '../strings'
import { areaRoutes } from '../routes'
import { ago, exact, when } from '@/lib/time'
import { auditKindTone, backupLevelTone, findingTone, verdictTone } from '@/lib/tones'
import { Empty, Fact, FactsRow, Page, PageHeader, Row, Rows, Section } from '@/components/page'
import { Dot, Pill } from '@/components/ui/pill'
import { cn } from '@/lib/utils'

/**
 * The page the operator leaves open. It opens with a verdict and the four
 * things they are responsible for, then what needs attention, then what has
 * happened -- the notable events, not the routine ones. Everything on it is
 * computed by the engine at request time; nothing here is a stored conclusion.
 */
export function Overview() {
  const { data, checkedAt } = useOverview()
  const a = data.assessment
  const now = useNow()

  const verdictWord =
    a.verdict === 'protected' ? S.verdictProtected : a.verdict === 'attention' ? S.verdictAttention : S.verdictRisk

  return (
    <Page>
      <PageHeader
        title={S.navOverview}
        description={S.overviewChecked(ago(new Date(checkedAt).toISOString(), now), data.bindAddress, data.appPort)}
      />

      <div className="space-y-6">
        <div className="flex items-baseline gap-3">
          <Dot tone={verdictTone(a.verdict)} className="size-2.5 translate-y-[-1px]" />
          <h2 className="font-serif text-[34px] leading-none font-[450] tracking-[-0.01em]">{verdictWord}</h2>
          <span className="text-sm text-muted-foreground">
            {a.findings.length === 0
              ? S.verdictNothing
              : S.verdictCount(a.findings.filter((f) => f.level === 'risk').length, a.findings.filter((f) => f.level === 'warn').length)}
          </span>
        </div>

        <FactsRow>
          <Fact
            eyebrow={S.factApplication}
            value={a.application.running ?? S.notRunning}
            caption={
              a.application.drift
                ? S.factDrift(a.application.configured)
                : data.services.some((s) => s.required && s.state !== 'running' && s.state !== 'external')
                  ? S.factServicesDown
                  : S.factServicesOk(data.services.filter((s) => s.state === 'running' || s.state === 'external').length)
            }
            tone={a.findings.some((f) => f.area === 'services' || f.area === 'deploy' || f.area === 'database') ? 'warning' : 'success'}
            to="/services"
          />
          <Fact
            eyebrow={S.factBackups}
            value={a.backups.newestAt ? ago(a.backups.newestAt, now) : S.never}
            caption={
              a.backups.level === 'ok'
                ? S.factBackupsCaption(ago(a.backups.nextDueAt, now), a.backups.sets)
                : a.backups.detail
            }
            tone={backupLevelTone(a.backups.level)}
            to="/backups"
          />
          <Fact
            eyebrow={S.factOffsite}
            value={a.offsite.enabled ? (a.offsite.ready ? (a.offsite.label ?? S.offsiteOn) : S.offsiteNotUsable) : S.offsiteOff}
            figure={false}
            caption={
              !a.offsite.enabled
                ? S.factOffsiteOffCaption
                : !a.offsite.ready
                  ? (a.offsite.reason ?? '')
                  : a.backups.offsitePending
                    ? S.factOffsitePending(a.backups.offsitePending)
                    : S.factOffsiteCurrent
            }
            tone={!a.offsite.enabled || !a.offsite.ready ? 'destructive' : a.backups.offsitePending ? 'warning' : 'success'}
            to="/backups"
          />
          <Fact
            eyebrow={S.factRecovery}
            value={a.recovery.passphraseSet ? (a.recovery.lastCopiedAt ? ago(a.recovery.lastCopiedAt, now) : S.notYet) : S.noPassphrase}
            figure={a.recovery.passphraseSet && Boolean(a.recovery.lastCopiedAt)}
            caption={
              a.recovery.passphraseSet
                ? a.recovery.verifiedAt
                  ? S.factRecoveryVerified(ago(a.recovery.verifiedAt, now))
                  : S.factRecoveryCaption
                : S.factRecoveryNoPassphrase
            }
            tone={a.recovery.passphraseSet ? (a.recovery.lastCopiedAt ? 'success' : 'warning') : 'warning'}
            to="/backups"
          />
        </FactsRow>
      </div>

      {a.findings.length > 0 && (
        <Section title={S.attentionTitle} description={S.attentionExplainer}>
          <Rows>
            {a.findings.map((finding, index) => (
              <Row key={`${finding.area}-${index}`} to={areaRoutes[finding.area] ?? '/'}>
                <Dot tone={findingTone(finding.level)} className="mt-0.5 self-start translate-y-[7px]" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{finding.title}</div>
                  {finding.detail && <div className="text-xs text-muted-foreground">{finding.detail}</div>}
                </div>
              </Row>
            ))}
          </Rows>
        </Section>
      )}

      <Section
        title={S.activityTitle}
        description={S.activityExplainer}
        actions={
          <Link to="/activity" className="text-xs font-medium text-muted-foreground hover:text-foreground">
            {S.activityAll} →
          </Link>
        }
      >
        {data.audit.length === 0 ? (
          <Empty>{S.auditEmpty}</Empty>
        ) : (
          <Rows>
            {data.audit.map((entry, index) => (
              <Row key={`${entry.at}-${index}`}>
                <Pill tone={auditKindTone(entry.kind)} size="sm" className="w-16 justify-center">
                  {S.auditKind[entry.kind]}
                </Pill>
                <div className="min-w-0 flex-1">
                  <span className="text-sm">{entry.label}</span>
                  {entry.detail && <span className="text-sm text-muted-foreground"> — {entry.detail}</span>}
                  {entry.subject && <span className="text-xs text-muted-foreground"> · {entry.subject}</span>}
                </div>
                <time
                  dateTime={entry.at}
                  title={exact(entry.at)}
                  className={cn('shrink-0 text-xs text-muted-foreground')}
                >
                  {when(entry.at)}
                </time>
              </Row>
            ))}
          </Rows>
        )}
      </Section>
    </Page>
  )
}

/** A clock that ticks once a minute, so "12 min ago" stays true without a fetch. */
function useNow(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}
