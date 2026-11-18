export class CommandError extends Error {
  readonly code: 'forbidden' | 'version_conflict' | 'command_conflict';
  readonly status: 403 | 409;

  constructor(code: CommandError['code'], status: CommandError['status']) {
    super(code);
    this.name = 'CommandError';
    this.code = code;
    this.status = status;
  }
}
