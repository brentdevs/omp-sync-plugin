/** Only plugin-authored, non-secret guidance may be shown verbatim in the UI. */
export class UserError extends Error {
  constructor(message: string) { super(message); this.name = "UserError"; }
}
