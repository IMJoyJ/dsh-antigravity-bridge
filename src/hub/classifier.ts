/**
 * Error signature classifier for transient vs terminal cascade errors in Google Antigravity.
 *
 * Transient retryable errors:
 * 1. Empty model output ('model_output_empty')
 * 2. Interrupted stream ('stream_interrupted')
 * 3. Expired OAuth access token ('auth_token_expired') - HTTP 401 with invalid_token / UNAUTHENTICATED
 *
 * Terminal non-retryable errors:
 * - DELIVERY FAILED / hub-side dead state
 * - 403 / PERMISSION_DENIED (permission issues)
 * - Persistent OAuth failure ("OAuth 凭据已失效，请重新登录 Antigravity", invalid_grant, revoked refresh token)
 */

export type TransientErrorSignature =
  | 'model_output_empty'
  | 'stream_interrupted'
  | 'auth_token_expired'
  | 'network_error'
  | 'model_format_error';

export interface ErrorClassification {
  /** Whether this error is a transient error eligible for auto-resume. */
  retryable: boolean;
  /** Transient error signature identifier if retryable. */
  signature?: TransientErrorSignature;
  /** Explanatory reason if terminal / non-retryable. */
  reason?: string;
  /** Normalized raw error message text. */
  rawError: string;
  /** Whether the retry is handled internally by the engine/IDE (bridge should not inject '继续'). */
  engineInternal?: boolean;
  /** Remaining retries reported by the engine/model, if applicable. */
  retriesRemaining?: number;
}

/** Explicit terminal patterns that must NEVER be retried. */
const TERMINAL_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  {
    reason: 'terminal_delivery_failed',
    pattern: /(?:DELIVERY FAILED|hub-side dead state)/i,
  },
  {
    reason: 'terminal_auth_permanent_failure',
    pattern: /(?:OAuth 凭据已失效|invalid_grant|refresh_token (?:expired|revoked|invalid))/i,
  },
  {
    reason: 'terminal_permission_denied',
    pattern: /(?:403\s*Forbidden|HTTP\s*403|PERMISSION_DENIED|Permission denied|无权限|access forbidden|caller does not have permission)/i,
  },
];

/** Pattern recognizing model format and malformed function call errors. */
export const MODEL_FORMAT_ERROR_PATTERN =
  /(?:improperly formatted function call|Malformed function call|Failed to parse function call|Function call is empty|Please retry with a properly formatted function call)/i;

/** Common network, transport, server unavailable, and connection error pattern. */
export const NETWORK_ERROR_PATTERN =
  /(?:network\s*(?:error|timeout)|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|socket hang up|connection (?:reset|closed|aborted|refused)|connect(?:ion)? refused|stream (?:disconnected|closed|error)|event stream (?:closed|error|disconnected)|SSE (?:error|disconnect|closed)|UND_ERR_\w+|\b(?:502|503|504|429)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|Service Unavailable|Bad Gateway|Gateway Timeout|Too Many Requests|Rate limit|\bEOF\b|unexpected EOF|连接拒绝|拒绝连接|连接重置|网络异常|网络超时)/i;

/** Recognized transient retryable error signatures. */
const TRANSIENT_PATTERNS: Array<{ signature: TransientErrorSignature; pattern: RegExp }> = [
  {
    signature: 'model_output_empty',
    pattern: /model output (?:must contain either output text or tool calls|error)/i,
  },
  {
    signature: 'stream_interrupted',
    pattern: /(?:stream was interrupted|continue the task you were working on)/i,
  },
  {
    signature: 'network_error',
    pattern: NETWORK_ERROR_PATTERN,
  },
];

/** Default exponential backoff delay schedule for auto-resume: 2s, 5s, 10s. */
export const BACKOFF_SCHEDULE_MS = [2000, 5000, 10000] as const;

/**
 * Checks if the error string matches an expired/invalid OAuth access token (HTTP 401 invalid_token / UNAUTHENTICATED).
 */
export function isAuthTokenExpiredError(rawError: string): boolean {
  // First ensure it's not a permanent auth failure or a 403 permission denied error
  for (const term of TERMINAL_PATTERNS) {
    if (term.pattern.test(rawError)) {
      return false;
    }
  }

  const has401 = /(?:HTTP\s*401|401\s*Unauthorized|code["':\s]+401|status["':\s]+401|\b401\b)/i.test(rawError);
  const hasInvalidToken = /invalid_token/i.test(rawError);
  const hasUnauthenticated = /UNAUTHENTICATED/i.test(rawError);
  const hasWwwAuth = /Www-Authenticate/i.test(rawError);

  // 1. HTTP 401 with invalid_token or UNAUTHENTICATED
  if (has401 && (hasInvalidToken || hasUnauthenticated)) {
    return true;
  }

  // 2. Www-Authenticate header containing invalid_token
  if (hasWwwAuth && hasInvalidToken) {
    return true;
  }

  // 3. invalid_token present in authentication response context
  if (hasInvalidToken) {
    return true;
  }

  // 4. UNAUTHENTICATED with 401 code
  if (hasUnauthenticated && has401) {
    return true;
  }

  return false;
}

/**
 * Get backoff delay in ms for a given 0-based retry index.
 * For auth_token_expired, returns 1000ms (1s) to allow hub-side token refresh.
 * For other transient errors: 0 -> 2000ms, 1 -> 5000ms, 2+ -> 10000ms.
 */
export function getAutoResumeBackoffMs(retryIndex: number, signature?: TransientErrorSignature): number {
  if (signature === 'auth_token_expired') {
    return 1000;
  }
  if (retryIndex < 0) return BACKOFF_SCHEDULE_MS[0];
  if (retryIndex < BACKOFF_SCHEDULE_MS.length) {
    return BACKOFF_SCHEDULE_MS[retryIndex];
  }
  return BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1];
}

/**
 * Get maximum allowed retries for a given error signature.
 * auth_token_expired is capped at 2 retries; standard transient errors use config (default 3).
 */
export function getMaxRetriesForSignature(signature?: TransientErrorSignature, configMaxRetries = 3): number {
  if (signature === 'auth_token_expired') {
    return Math.min(configMaxRetries, 2);
  }
  return configMaxRetries;
}

/**
 * Format terminal error for expired/invalid OAuth credentials.
 */
export function formatAuthExpiredTerminalError(details?: string): string {
  const base = 'OAuth 凭据已失效，请重新登录 Antigravity';
  return details ? `${base} (${details})` : base;
}

/**
 * Format error message when auto-resume retries are exhausted.
 */
export function formatExhaustedRetryError(
  retries: number,
  originalError: string,
  signature?: TransientErrorSignature,
): string {
  if (signature === 'auth_token_expired') {
    return formatAuthExpiredTerminalError(`已自动重试 ${retries} 次仍失败: ${originalError}`);
  }
  if (signature === 'network_error') {
    return `网络异常 (network error)，已自动重试 ${retries} 次仍失败: ${originalError}`;
  }
  if (signature === 'model_format_error') {
    return `模型输出格式错误重试耗尽 (model format error): ${originalError}`;
  }
  return `已自动重试 ${retries} 次仍失败: ${originalError}`;
}

/**
 * Checks if the error string matches a network error, connection drop, fetch failure, or socket timeout.
 */
export function isNetworkError(rawError: string): boolean {
  for (const term of TERMINAL_PATTERNS) {
    if (term.pattern.test(rawError)) {
      return false;
    }
  }
  return NETWORK_ERROR_PATTERN.test(rawError);
}

/**
 * Extracts remaining retries count from error messages containing "Retries remaining: N" or similar phrases.
 */
export function parseRetriesRemaining(rawError: string): number | undefined {
  const match = rawError.match(/retries\s+remaining[:\s]+(\d+)/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return undefined;
}

/**
 * Extracts the error string from various error containers (Error object, step, snapshot, string, HTTP response object).
 */
export function extractErrorMessage(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message;

  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    // TranscriptSnapshot or object with .error field
    if (typeof obj.error === 'string') {
      return obj.error;
    }
    // TranscriptStep (ERROR_MESSAGE step)
    if (obj.type === 'ERROR_MESSAGE' || obj.error_message) {
      const errObj = obj.error_message as
        | {
            error?: {
              short_error?: string;
              user_error_message?: string;
              code?: number | string;
              status?: string;
              message?: string;
            };
          }
        | undefined;
      const shortErr = errObj?.error?.short_error;
      const userErr = errObj?.error?.user_error_message;
      if (shortErr) return shortErr;
      if (userErr) return userErr;
      if (errObj?.error) {
        if (errObj.error.code && errObj.error.status) {
          return `HTTP ${errObj.error.code} ${errObj.error.status}: ${errObj.error.message || ''}`;
        }
        return JSON.stringify(errObj.error);
      }
    }
    // HTTP response structure with headers / body / status
    if (obj.headers || obj.body || obj.status !== undefined || obj.code !== undefined) {
      return JSON.stringify(obj);
    }
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.content === 'string') return obj.content;
  }

  return String(input);
}

/**
 * Classifies an error input into transient retryable vs terminal.
 */
export function classifyError(error: unknown): ErrorClassification {
  const rawError = extractErrorMessage(error).trim();
  if (!rawError) {
    return { retryable: false, rawError: '', reason: 'empty_error' };
  }

  // 1. Explicit terminal patterns (DELIVERY FAILED, dead state, permission denied, persistent auth failure)
  for (const item of TERMINAL_PATTERNS) {
    if (item.pattern.test(rawError)) {
      return {
        retryable: false,
        rawError,
        reason: item.reason,
      };
    }
  }

  // 1.5. Model format error and retries remaining check
  const retriesRemaining = parseRetriesRemaining(rawError);
  const isModelFormat = MODEL_FORMAT_ERROR_PATTERN.test(rawError);
  if (retriesRemaining !== undefined) {
    if (retriesRemaining === 0) {
      return {
        retryable: false,
        rawError,
        reason: 'model_format_retries_exhausted',
        retriesRemaining: 0,
      };
    }
    return {
      retryable: true,
      signature: 'model_format_error',
      rawError,
      engineInternal: true,
      retriesRemaining,
    };
  }
  if (isModelFormat) {
    return {
      retryable: true,
      signature: 'model_format_error',
      rawError,
      engineInternal: true,
    };
  }

  // 2. Auth token expired (HTTP 401 invalid_token / UNAUTHENTICATED) -> transient retryable
  if (isAuthTokenExpiredError(rawError)) {
    return {
      retryable: true,
      signature: 'auth_token_expired',
      rawError,
    };
  }

  // 3. Known transient retryable patterns (model_output_empty, stream_interrupted, network_error)
  for (const item of TRANSIENT_PATTERNS) {
    if (item.pattern.test(rawError)) {
      return {
        retryable: true,
        signature: item.signature,
        rawError,
      };
    }
  }

  // 4. Fallback: unclassified errors are not auto-retryable
  return {
    retryable: false,
    rawError,
    reason: 'unclassified_terminal_error',
  };
}

/**
 * Fast boolean check if an error is a transient retryable cascade error.
 */
export function isTransientRetryableError(error: unknown): boolean {
  return classifyError(error).retryable;
}

/**
 * Check if the error is handled internally by the IDE engine (e.g. model format retry).
 */
export function isInternalEngineRetryError(error: unknown): boolean {
  return Boolean(classifyError(error).engineInternal);
}
