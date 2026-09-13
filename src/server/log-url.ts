/**
 * What a request line may say about its URL.
 *
 * The Microsoft sign-in callback arrives with a one-time authorisation code
 * in its query, and Fastify's default request line printed the whole thing.
 * The code is single-use and lives for minutes, so nobody was let in by it --
 * but a log is read, copied into support bundles and kept, and a credential
 * of any lifetime does not belong there. Every other query on the API is a
 * page size or a filter and is worth seeing.
 */
export function loggedUrl(url: string): string {
  const query = url.indexOf('?')
  if (query < 0) return url
  const path = url.slice(0, query)
  return path === '/api/session/entra/callback' ? `${path}?…` : url
}
