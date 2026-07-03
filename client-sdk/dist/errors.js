/** Error types raised by {@link AgentClient}. */
export class AgentClientError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = "AgentClientError";
    }
    toString() {
        return `${this.message} (HTTP ${this.status})`;
    }
}
//# sourceMappingURL=errors.js.map