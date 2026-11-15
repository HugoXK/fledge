// #666: a failure that is recorded after a command already committed has to stay
// readable months later, from a row and not from a log. The class separates "the
// store refused the write" (`SQLiteError`) from "the code threw" (`TypeError`),
// and the message names the row; both are what an operator needs to decide
// whether a missing postmortem is repairable by hand.

export function errorClass(error: unknown): string {
  if (error instanceof Error && error.name !== '') return error.name
  return typeof error === 'string' ? 'string' : 'unknown'
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}
