/**
 * Signing in to TKU Arcade (e1-t37, worker/arcade-login.ts, ARCHITECTURE.md §5.2): the two paths
 * the Worker and the page share
 */

/** The endpoint the arcade's sign-in link opens */
export const ARCADE_LOGIN_API = '/api/arcade/login'
/** The page a signed-out visitor signs in on; once signed in it goes back to ARCADE_LOGIN_API with `resume=1` */
export const ARCADE_LOGIN_PAGE = '/arcade'
