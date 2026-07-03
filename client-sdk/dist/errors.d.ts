/** Error types raised by {@link AgentClient}. */
export declare class AgentClientError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(message: string, status: number, body: unknown);
    toString(): string;
}
//# sourceMappingURL=errors.d.ts.map