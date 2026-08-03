/**
 * FileRead limits — single source for tool prompt + read gates.
 * Values live in constants/api_limits; this module is the Read-facing façade.
 */
export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_LINES_TO_READ,
  MAX_OUTPUT_SIZE_BYTES,
  PDF_MAX_PAGES_PER_READ,
} from '../../constants/api_limits.js'
