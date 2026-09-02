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
}
