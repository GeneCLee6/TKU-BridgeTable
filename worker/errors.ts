import { AppError, type MessageCode, type MessageParams } from '../shared/messages.ts'

/** An error shown to the user; the code is translated in the browser */
export class ClubError extends AppError {
  constructor(code: MessageCode, params: MessageParams = {}, status = 400) {
    super(code, params, status)
  }
}
