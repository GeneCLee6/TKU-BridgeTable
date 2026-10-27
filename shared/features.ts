/**
 * Features that are built but switched off for now. Turning one back on is a one-line change here.
 *
 * Friends (好友, AC-1.6): only club members use the site, so nobody needs to follow anyone yet
 * (社長, 2026-10-27). While this is false the People tab, the profile card and the profile page show
 * no friend, pin or block buttons and no "friends only" filter, the account page has no
 * friend-online setting, and the server sends no friend-online notice. The friend and block lists,
 * their commands and their checks all stay; challenges and table invitations take any member either
 * way. Turning it back on is a task before the public launch (docs/ROADMAP.md).
 */
export const FRIENDS_ENABLED: boolean = false
