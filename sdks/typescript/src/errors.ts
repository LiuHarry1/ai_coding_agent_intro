/** Error types raised by {@link AgentClient}. */

export class AgentClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
    this.name = 'AgentClientError'
  }

  override toString(): string {
    return `${this.message} (HTTP ${this.status})`
  }
}
