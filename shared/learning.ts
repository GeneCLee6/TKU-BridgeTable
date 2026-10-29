/**
 * 淡江橋館's learning paths (BridgeHall E4, e4-t08 e4-t11 e4-t12): a path is lessons in order, each
 * a list of what to read in the handbook (a convention, or one of its sections), the practice
 * questions to try (e4-t10) and a checklist. The handbook bundles its own paths (「從零開始」); an
 * editor's saved version of a path replaces the bundled one. A member's progress is the lessons they
 * marked done. The same types are in the handbook's `src/lib/learning.ts` (type parity, CLAUDE.md
 * rule 10).
 *
 * What a lesson says is the club's (CLAUDE.md rule 1 in the handbook): the Worker checks only the
 * shape.
 */

export const LEARNING_LIMITS = {
  /** Paths saved online */
  pathsMax: 20,
  lessonsMax: 40,
  readingsMax: 20,
  quizzesMax: 40,
  checklistMax: 20,
  idMax: 40,
  nameMax: 60,
  titleMax: 80,
  /** A lesson's goal, and one checklist item */
  textMax: 1000,
  quizIdMax: 200,
} as const

export interface LessonReading {
  slug: string
  /** One section; the whole convention without it */
  sectionId?: string
}

export interface Lesson {
  id: string
  title: string
  /** What the lesson is for; empty until an editor writes it */
  goal: string
  readings: LessonReading[]
  /** Practice question ids (e4-t10) */
  quizIds?: string[]
  checklist: string[]
}

export interface LearningPath {
  id: string
  name: string
  lessons: Lesson[]
}

/** A path as saved online: who saved it and when */
export type SavedLearningPath = LearningPath & { by: string; at: number }

/** A member's progress on one path: the lessons marked done */
export interface PathProgress {
  pathId: string
  done: string[]
  at: number
}

/** Marking one lesson done, or not */
export interface PathProgressInput {
  pathId: string
  lessonId: string
  done: boolean
}
