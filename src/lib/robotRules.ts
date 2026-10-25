/**
 * The robots' rules and words for the browser (ROBOT.md §6): what a robot's call shows in the
 * viewer's language, and what each call would show to a robot partner (the bidding box hints).
 * Loaded on its own by `useRobotRules`, only at tables that need it.
 */
export { describe } from '../../shared/robot/system/describe.ts'
export { explain } from '../../shared/robot/system/engine.ts'
export { ROBOT_SYSTEMS } from '../../shared/robot/robots.ts'
export { bookTopics } from '../../shared/book-topics.ts'
export { callText, conventionName } from '../../shared/robot/system/describe.ts'
