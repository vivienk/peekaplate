export class CommandError extends Error {
  constructor(
    readonly code: 'forbidden' | 'version_conflict' | 'command_conflict',
    readonly status: 403 | 409,
  ) {
    super(code);
    this.name = 'CommandError';
  }
}
