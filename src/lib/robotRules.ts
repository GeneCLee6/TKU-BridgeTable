/**
 * The robots' words for the browser (ROBOT.md §6): what a call shows (a robot's call, the engine's
 * reading of a person's, the bidding box hints the server sends) in the viewer's language, and the
 * names on the hint card (`BookHints`). The meanings and the card's pages come from the server
 * (`BoardView.callMeanings`, `BoardView.bookTopics`): no engine here (CLAUDE.md rule 1). Loaded on its
 * own by `useRobotRules`, only at tables that need it.
 */
export { describe } from '../../shared/robot/system/describe.ts'
export { callText, conventionName } from '../../shared/robot/system/describe.ts'
