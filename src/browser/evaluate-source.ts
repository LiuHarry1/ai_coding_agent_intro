/**
 * Turns an expression, statement body, or function source into something
 * `page.evaluate` can run. Playwright-free.
 */

import { Script } from 'node:vm'

const FUNCTION_SOURCE_PATTERN =
  /^(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/
const EXPRESSION_RESULT_NAME = '__agentEvaluateExpressionResult'

function canParseAsExpression(source: string): boolean {
  try {
    const parseExpression = new Script(`"use strict";\n(${source});`)
    void parseExpression
    return true
  } catch {
    return false
  }
}

export function normalizeBrowserEvaluateFunctionSource(
  source: string,
  params: { argumentName?: string } = {},
): string {
  const trimmed = source.trim()
  if (!trimmed) return ''
  if (FUNCTION_SOURCE_PATTERN.test(trimmed) && canParseAsExpression(trimmed)) {
    return trimmed
  }
  const argumentName = params.argumentName
  const args = argumentName ? `(${argumentName})` : '()'
  if (canParseAsExpression(trimmed)) {
    const invokeArgs = argumentName ? argumentName : ''
    return [
      `${args} => {`,
      `const ${EXPRESSION_RESULT_NAME} = (${trimmed});`,
      `return typeof ${EXPRESSION_RESULT_NAME} === "function" ? ${EXPRESSION_RESULT_NAME}(${invokeArgs}) : ${EXPRESSION_RESULT_NAME};`,
      '}',
    ].join('\n')
  }
  return `async ${args} => {\n${trimmed}\n}`
}
