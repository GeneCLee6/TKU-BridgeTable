import type { Me } from '../../shared/protocol.ts'

/** The two-step sign-in card's id on the account page, which the admin page's banner links to */
export const TWO_FACTOR_ANCHOR = 'two-factor'

/**
 * Whether the member is an admin who still has to turn two-step sign-in on (社長 2026-11-02): the
 * server refuses their admin requests with `adminTwoFactorRequired` until then
 */
export const mustTurnOnTwoFactor = (user: Me | null | undefined) => !!user?.admin && !!user.twoFactor?.required
