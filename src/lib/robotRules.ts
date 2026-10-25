/**
 * The robots' words for the browser (ROBOT.md §6): what a call shows (a robot's call, the engine's
 * reading of a person's, the bidding box hints the server sends) in the viewer's language, and the
 * practice table's hint card (`BookHints`). The bidding box hints themselves come from the server
 * (`BoardView.callMeanings`). Loaded on its own by `useRobotRules`, only at tables that need it.
 */
export { describe } from '../../shared/robot/system/describe.ts'
export { ROBOT_SYSTEMS } from '../../shared/robot/robots.ts'
export { bookTopics } from '../../shared/book-topics.ts'
export { callText, conventionName } from '../../shared/robot/system/describe.ts'
