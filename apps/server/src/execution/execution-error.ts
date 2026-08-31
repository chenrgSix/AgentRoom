export class ExecutionError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: 400 | 404 | 409 = 400
  ) {
    super(code);
    this.name = "ExecutionError";
  }
}
