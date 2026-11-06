/**
 * Leaving the site for another one (Google's sign-in page, e1-t31). An object, so component tests
 * can replace `to` (jsdom cannot navigate)
 */
export const leave = {
  to(url: string) {
    window.location.assign(url)
  },
}
