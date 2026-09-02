/**
 * Every user-facing string, in one place.
 *
 * The engine is English-only by decision — its user administers a box, and its
 * vocabulary is Docker, versions and backups. This module is the one cheap
 * precaution that decision requires: nothing user-facing is written inline in
 * JSX, so if a firm ever asks for Arabic it is a week of translating this
 * file, not a month of hunting through components.
 */
export const S = {
  productName: 'QanoonTech Engine',

  // Setup and sign-in
  setupTitle: 'Set the operator password',
  setupExplainer:
    'This password controls the deployment: versions, services, backups. It is not a user account in QanoonTech.',
  setupPasswordRule: 'At least 12 characters.',
  setupSubmit: 'Set password and continue',
  loginTitle: 'Sign in',
  loginPassword: 'Operator password',
  loginSubmit: 'Sign in',
  logout: 'Sign out',

  // Navigation
  navOverview: 'Overview',
  navServices: 'Services',

  // Overview
  overviewTitle: 'Overview',
  versionLabel: 'QanoonTech version',
  engineVersionLabel: 'Engine',
  addressLabel: 'Serving on',
  planDeployable: 'Deployable',
  planProblemsTitle: 'This deployment cannot be rendered:',
  servicesHealthy: 'All services healthy',
  dockerUnreachable: 'Docker did not answer:',
  auditTitle: 'Recent activity',
  auditEmpty: 'Nothing yet.',

  // Services
  servicesTitle: 'Services',
  requiredBadge: 'required',
  stateAbsent: 'not created',
  actionStart: 'Start',
  actionStop: 'Stop',
  actionRestart: 'Restart',
  actionLogs: 'Logs',
  logsTitle: (service: string) => `Logs — ${service}`,
  logsEmpty: 'No output.',
  close: 'Close',

  // Deploy
  navDeploy: 'Deploy',
  deployTitle: 'Deploy',
  registryTitle: 'Registry credential',
  registryExplainer:
    'Issued per firm, with read:packages only. It is how the software is downloaded — and revoking it is how a licence ends completely.',
  registryUsername: 'Username',
  registryToken: 'Token',
  registryConfigured: (username: string) => `Configured as ${username}.`,
  registrySave: 'Verify and save',
  settingsTitle: 'Deployment settings',
  settingsBindAddress: 'Serve on address',
  settingsBindAddressHint:
    '0.0.0.0 serves the whole LAN (the default). Narrow it to 127.0.0.1 or a specific address when fronting with the Cloudflare tunnel.',
  settingsAppPort: 'Application port',
  settingsTimezone: 'Timezone',
  settingsLanguage: 'Default language',
  settingsSave: 'Save settings',
  settingsSaved: 'Saved.',
  modulesTitle: 'Modules',
  modulesExplainer: 'Optional, off by default, and the cost is stated. The licence decides which may be enabled.',
  moduleEnable: 'Enable',
  moduleDisable: 'Disable',
  moduleConfigure: 'Configure',
  moduleConfigSave: 'Save configuration',
  moduleConfigSaved: 'Saved.',
  secretSet: 'set',
  secretReplacePlaceholder: 'Already set — enter a value to replace it',
  secretChooseFile: 'Choose file…',
  versionTitle: 'Version',
  versionCurrent: 'Configured version',
  versionPrevious: 'Previous',
  versionChoose: 'Choose a version',
  versionSet: 'Set version',
  versionRollback: 'Roll back',
  versionRollbackWarn:
    'The application migrates its database forward on start; an older version may refuse a newer database. The pre-update backup is the way back.',
  preflightTitle: 'Preflight',
  preflightRun: 'Run checks',
  preflightBlocked: 'Blocked — fix the failures above before deploying.',
  deployRunTitle: 'Deploy',
  deployExplainer:
    'Renders the deployment, checks it, downloads images, then applies. A failed download touches nothing that is running.',
  deployStart: 'Deploy now',
  deployRunning: 'Deploying…',
  deployDone: 'Deployed.',
  deployFailed: 'Deploy failed — the log has the reason.',

  // Backups
  navBackups: 'Backups',
  backupsTitle: 'Backups',
  backupsExplainer:
    'Taken nightly, before every update, and before every restore. Kept on this box; the offsite copy is the next piece of work.',
  backupTakeNow: 'Back up now',
  backupTaking: 'Backing up…',
  backupRestore: 'Restore',
  backupDelete: 'Delete',
  backupRestoreConfirm: (id: string) =>
    `Restore ${id}? The application will stop during the restore. A safety backup is taken first, so this is reversible.`,
  backupDeleteConfirm: (id: string) => `Delete backup ${id}? This cannot be undone.`,
  backupEmpty: 'No backups yet.',
  backupTrigger: {
    manual: 'manual',
    scheduled: 'nightly',
    'pre-update': 'before update',
    'pre-restore': 'safety copy',
  } as Record<string, string>,
  restoreStepsTitle: 'Restore steps',
  supportTitle: 'Support bundle',
  supportExplainer:
    'A redacted snapshot of this deployment — states, logs, configuration — for sending to support. No documents, no database rows, no secrets. Nothing is sent anywhere; you download it and decide.',
  supportDownload: 'Download support bundle',

  // Licence
  navLicence: 'Licence',
  licenceTitle: 'Licence',
  licenceFirm: 'Licensed to',
  licenceId: 'Licence id',
  licenceExpires: 'Expires',
  licenceSeats: 'Seats',
  licenceSeatsUnlimited: 'Unlimited',
  licenceEntitlements: 'Modules entitled',
  licenceHeartbeatOk: 'Last confirmed',
  licenceInstallTitle: 'Install a licence',
  licenceInstallExplainer:
    'Paste the licence exactly as it was issued. Installing a new licence replaces the current one and clears any enforcement.',
  licenceInstallSubmit: 'Install',
  licenceInstalled: 'Licence installed.',
  licenceOverrideBadge: 'override licence',
  licenceEnforcedBanner:
    'The deployment has been stopped over its licence. The data is intact and backups continue. Install a valid licence to bring it back.',

  // Errors
  errorGeneric: 'Something went wrong. The details are in the engine log.',
  workingEllipsis: 'Working…',
} as const

export const auditEventLabels: Record<string, string> = {
  setup: 'Operator password set',
  login: 'Signed in',
  'login-failed': 'Failed sign-in attempt',
  'login-locked': 'Sign-in refused: locked out',
  logout: 'Signed out',
  'service-start': 'Service started',
  'service-stop': 'Service stopped',
  'service-restart': 'Service restarted',
  'licence-installed': 'Licence installed',
  'licence-enforced': 'Licence enforcement: deployment stopped',
  'licence-cleared': 'Licence enforcement lifted: deployment restarted',
}
