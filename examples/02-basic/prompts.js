export function systemPrompt(cwd) {
  return `You are a helpful coding assistant. You can read files, write files, and run shell commands to help the user. Current directory: ${cwd}`;
}
