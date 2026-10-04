import { describe, it, expect } from 'vitest';
import {
  classifyError,
  isTransientRetryableError,
  isAuthTokenExpiredError,
  extractErrorMessage,
  getAutoResumeBackoffMs,
  getMaxRetriesForSignature,
  formatExhaustedRetryError,
  formatAuthExpiredTerminalError,
  BACKOFF_SCHEDULE_MS,
  parseRetriesRemaining,
  isInternalEngineRetryError,
  isNetworkError,
  TLS_TRANSPORT_ERROR_PATTERN,
} from '../src/hub/classifier.js';
import { Config } from '../src/index.js';

describe('Error Signature Classifier', () => {
  describe('Transient Retryable Signatures', () => {
    const signature1Samples = [
      'Error: model output error: model output must contain either output text or tool calls, these cannot both be empty, please try again',
      'model output error: model output must contain either output text or tool calls, these cannot both be empty, please try again',
      'MODEL OUTPUT ERROR: model output must contain either output text or tool calls, these cannot both be empty, please try again',
      'model output error: please try again',
    ];

    const signature2Samples = [
      'Error: The stream was interrupted. Please continue the task you were working on.',
      'The stream was interrupted. Please continue the task you were working on.',
      'Error: the stream was interrupted.',
      'Please continue the task you were working on.',
    ];

    it('should classify Signature 1 (Empty model output) as retryable', () => {
      for (const msg of signature1Samples) {
        const result = classifyError(msg);
        expect(result.retryable).toBe(true);
        expect(result.signature).toBe('model_output_empty');
        expect(isTransientRetryableError(msg)).toBe(true);
      }
    });

    it('should classify Signature 2 (Stream interrupted) as retryable', () => {
      for (const msg of signature2Samples) {
        const result = classifyError(msg);
        expect(result.retryable).toBe(true);
        expect(result.signature).toBe('stream_interrupted');
        expect(isTransientRetryableError(msg)).toBe(true);
      }
    });

    it('should handle JavaScript Error objects containing transient messages', () => {
      const err1 = new Error('Error: model output error: model output must contain either output text or tool calls, these cannot both be empty, please try again');
      const err2 = new Error('The stream was interrupted. Please continue the task you were working on.');

      expect(isTransientRetryableError(err1)).toBe(true);
      expect(isTransientRetryableError(err2)).toBe(true);
    });

    it('should handle mock TranscriptSnapshot objects', () => {
      const snap1 = {
        error: 'Error: model output error: model output must contain either output text or tool calls, these cannot both be empty, please try again',
        isFinished: false,
        plannerContents: [],
      };
      const snap2 = {
        error: 'Error: The stream was interrupted. Please continue the task you were working on.',
        isFinished: false,
        plannerContents: ['some prior text'],
      };

      expect(isTransientRetryableError(snap1)).toBe(true);
      expect(isTransientRetryableError(snap2)).toBe(true);
    });

    it('should handle mock trajectory ERROR_MESSAGE steps', () => {
      const step1 = {
        step_index: 42,
        source: 'SYSTEM',
        type: 'ERROR_MESSAGE',
        status: 'ERROR',
        error_message: {
          error: {
            short_error: 'Error: model output error: model output must contain either output text or tool calls, these cannot both be empty, please try again',
          },
        },
      };

      const step2 = {
        step_index: 78,
        source: 'SYSTEM',
        type: 'ERROR_MESSAGE',
        status: 'ERROR',
        error_message: {
          error: {
            user_error_message: 'Error: The stream was interrupted. Please continue the task you were working on.',
          },
        },
      };

      expect(extractErrorMessage(step1)).toBe(
        'Error: model output error: model output must contain either output text or tool calls, these cannot both be empty, please try again'
      );
      expect(isTransientRetryableError(step1)).toBe(true);

      expect(extractErrorMessage(step2)).toBe(
        'Error: The stream was interrupted. Please continue the task you were working on.'
      );
      expect(isTransientRetryableError(step2)).toBe(true);
    });
  });

  describe('OAuth 401 Invalid Token / Expired Access Token', () => {
    it('should detect and classify invalid_token header format as retryable auth_token_expired', () => {
      const headerFormat1 = 'HTTP 401 Unauthorized\r\nWww-Authenticate: Bearer realm="https://accounts.google.com/", error="invalid_token"';
      const headerFormat2 = 'Www-Authenticate: Bearer realm="https://accounts.google.com/", error="invalid_token"';
      const headerObj = {
        headers: {
          'Www-Authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"',
        },
        status: 401,
      };

      const res1 = classifyError(headerFormat1);
      expect(res1.retryable).toBe(true);
      expect(res1.signature).toBe('auth_token_expired');
      expect(isAuthTokenExpiredError(headerFormat1)).toBe(true);

      const res2 = classifyError(headerFormat2);
      expect(res2.retryable).toBe(true);
      expect(res2.signature).toBe('auth_token_expired');

      const res3 = classifyError(headerObj);
      expect(res3.retryable).toBe(true);
      expect(res3.signature).toBe('auth_token_expired');
    });

    it('should detect and classify UNAUTHENTICATED body format as retryable auth_token_expired', () => {
      const bodyJson = '{"error":{"code":401,"status":"UNAUTHENTICATED","message":"Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential."}}';
      const bodyFormatted = 'HTTP 401 UNAUTHENTICATED: Request had invalid authentication credentials. Expected OAuth 2 access token';
      const bodyObj = {
        body: {
          error: {
            code: 401,
            status: 'UNAUTHENTICATED',
            message: 'Token expired',
          },
        },
      };

      const res1 = classifyError(bodyJson);
      expect(res1.retryable).toBe(true);
      expect(res1.signature).toBe('auth_token_expired');

      const res2 = classifyError(bodyFormatted);
      expect(res2.retryable).toBe(true);
      expect(res2.signature).toBe('auth_token_expired');

      const res3 = classifyError(bodyObj);
      expect(res3.retryable).toBe(true);
      expect(res3.signature).toBe('auth_token_expired');
    });

    it('should detect trajectory ERROR_MESSAGE step with code: 401 and status: UNAUTHENTICATED', () => {
      const step = {
        step_index: 105,
        source: 'SYSTEM',
        type: 'ERROR_MESSAGE',
        status: 'ERROR',
        error_message: {
          error: {
            code: 401,
            status: 'UNAUTHENTICATED',
            message: 'Request had invalid authentication credentials. Expected OAuth 2 access token',
          },
        },
      };

      const extracted = extractErrorMessage(step);
      expect(extracted).toContain('401');
      expect(extracted).toContain('UNAUTHENTICATED');
      const res = classifyError(step);
      expect(res.retryable).toBe(true);
      expect(res.signature).toBe('auth_token_expired');
    });

    it('should use 1s backoff delay and cap retries at 2 for auth_token_expired', () => {
      expect(getAutoResumeBackoffMs(0, 'auth_token_expired')).toBe(1000);
      expect(getAutoResumeBackoffMs(1, 'auth_token_expired')).toBe(1000);
      expect(getMaxRetriesForSignature('auth_token_expired', 3)).toBe(2);
      expect(getMaxRetriesForSignature('auth_token_expired', 5)).toBe(2);
      expect(getMaxRetriesForSignature('model_output_empty', 3)).toBe(3);
    });

    it('should format terminal error when auth retries are exhausted', () => {
      const formatted = formatExhaustedRetryError(2, 'HTTP 401 invalid_token', 'auth_token_expired');
      expect(formatted).toContain('OAuth 凭据已失效，请重新登录 Antigravity');
      expect(formatted).toContain('已自动重试 2 次仍失败');
    });
  });

  describe('Transient Network Error Signatures', () => {
    const networkSamples = [
      'Network error connecting to gemini: fetch failed',
      'TypeError: fetch failed',
      'Error: ECONNRESET',
      'ECONNREFUSED 127.0.0.1:7778',
      'Error: socket hang up',
      'ETIMEDOUT',
      'EPIPE: broken pipe',
      'ENOTFOUND gemini.google.com',
      'SSE disconnect: stream closed',
      'event stream disconnected: connection reset by peer',
      'Cascade stalled: no progress or heartbeat for 120s (network error or stream interrupted)',
      'UND_ERR_CONNECT_TIMEOUT',
    ];

    it('should classify network errors, connection drops, and stalled streams as retryable network_error', () => {
      for (const msg of networkSamples) {
        const result = classifyError(msg);
        expect(result.retryable).toBe(true);
        expect(result.signature).toBe('network_error');
        expect(isTransientRetryableError(msg)).toBe(true);
      }
    });

    it('should handle JavaScript Error objects containing network error messages', () => {
      const err1 = new TypeError('fetch failed');
      const err2 = new Error('read ECONNRESET');
      const err3 = new Error('socket hang up');

      expect(classifyError(err1).signature).toBe('network_error');
      expect(classifyError(err2).signature).toBe('network_error');
      expect(classifyError(err3).signature).toBe('network_error');
    });

    it('should format retry exhausted error for network_error with clear escalation message', () => {
      const formatted = formatExhaustedRetryError(3, 'fetch failed', 'network_error');
      expect(formatted).toContain('网络异常 (network error)');
      expect(formatted).toContain('已自动重试 3 次仍失败');
      expect(formatted).toContain('fetch failed');
    });

    it('should use standard 3 retries and exponential backoff schedule for network_error', () => {
      expect(getMaxRetriesForSignature('network_error')).toBe(3);
      expect(getAutoResumeBackoffMs(0, 'network_error')).toBe(2000);
      expect(getAutoResumeBackoffMs(1, 'network_error')).toBe(5000);
      expect(getAutoResumeBackoffMs(2, 'network_error')).toBe(10000);
    });
  });

  describe('Terminal / Non-Retryable Signatures', () => {
    const terminalSamples = [
      'DELIVERY FAILED for ed414fea-72d4-4342-bb12-c28df96874e8: message not visible in transcript after send + resend. The conversation may be in a hub-side dead state; start a fresh cascade.',
      'DELIVERY FAILED for c12345: message not visible in transcript after send + plain resend. The cascade may need a fresh conversation or IDE-side nudge.',
      'The conversation may be in a hub-side dead state; start a fresh cascade.',
      'StartCascade was silently rejected by the hub (empty response): the projectId is not registered.',
      'CreateProject was accepted by the hub but the project was not persisted',
      'Cascade execution timed out after 300s',
      'No pending requestedInteraction in trajectory',
      'unknown agent error (raw: {"code":400,"message":"Bad Request"})',
      'unknown agent error (raw: {"foo":"bar"})',
    ];

    it('should classify terminal errors and DELIVERY FAILED dead states as non-retryable', () => {
      for (const msg of terminalSamples) {
        const result = classifyError(msg);
        expect(result.retryable).toBe(false);
        expect(isTransientRetryableError(msg)).toBe(false);
      }
    });

    it('should classify persistent 401 / OAuth failures as terminal non-retryable', () => {
      const permanentAuthErrors = [
        'OAuth 凭据已失效，请重新登录 Antigravity',
        'OAuth 凭据已失效，请重新登录 Antigravity (已自动重试 2 次仍失败: HTTP 401 invalid_token)',
        'Error: invalid_grant: refresh token expired',
        'Error: refresh_token revoked by user',
      ];

      for (const err of permanentAuthErrors) {
        const result = classifyError(err);
        expect(result.retryable).toBe(false);
        expect(result.reason).toBe('terminal_auth_permanent_failure');
        expect(isTransientRetryableError(err)).toBe(false);
      }
    });

    it('should NOT misclassify 403 / PERMISSION_DENIED as retryable (普通 403 不误伤)', () => {
      const permissionDeniedErrors = [
        'HTTP 403 Forbidden',
        '403 Forbidden: model access denied for project',
        'PERMISSION_DENIED: The caller does not have permission',
        'Error: Permission denied to access gemini-3.7-pro',
        'key 无权限访问模型',
        'Access forbidden: caller does not have permission to execute this model',
      ];

      for (const err of permissionDeniedErrors) {
        const result = classifyError(err);
        expect(result.retryable).toBe(false);
        expect(result.reason).toBe('terminal_permission_denied');
        expect(isTransientRetryableError(err)).toBe(false);
      }
    });

    it('should prioritize terminal markers even if transient keywords are present', () => {
      const mixed = 'DELIVERY FAILED: The stream was interrupted and conversation is in a hub-side dead state';
      const result = classifyError(mixed);
      expect(result.retryable).toBe(false);
      expect(result.reason).toBe('terminal_delivery_failed');
    });

    it('should handle empty or nullish inputs safely', () => {
      expect(classifyError(null).retryable).toBe(false);
      expect(classifyError(undefined).retryable).toBe(false);
      expect(classifyError('').retryable).toBe(false);
      expect(classifyError({}).retryable).toBe(false);
    });
  });

  describe('Backoff Schedule & Exhausted Error Formatting', () => {
    it('should return correct exponential backoff schedule (2s, 5s, 10s)', () => {
      expect(BACKOFF_SCHEDULE_MS).toEqual([2000, 5000, 10000]);
      expect(getAutoResumeBackoffMs(0)).toBe(2000);
      expect(getAutoResumeBackoffMs(1)).toBe(5000);
      expect(getAutoResumeBackoffMs(2)).toBe(10000);
      expect(getAutoResumeBackoffMs(3)).toBe(10000);
      expect(getAutoResumeBackoffMs(99)).toBe(10000);
      expect(getAutoResumeBackoffMs(-1)).toBe(2000);
    });

    it('should format exhausted retries message clearly', () => {
      const err = 'Error: model output error: model output must contain either output text or tool calls, these cannot both be empty, please try again';
      const formatted = formatExhaustedRetryError(3, err);
      expect(formatted).toBe(`已自动重试 3 次仍失败: ${err}`);
      expect(formatted).toContain('已自动重试 3 次仍失败');
    });

    it('should format auth expired terminal message cleanly', () => {
      expect(formatAuthExpiredTerminalError()).toBe('OAuth 凭据已失效，请重新登录 Antigravity');
      expect(formatAuthExpiredTerminalError('token revoked')).toBe(
        'OAuth 凭据已失效，请重新登录 Antigravity (token revoked)'
      );
    });
  });

  describe('Config Schema & Defaults', () => {
    it('should apply autoResume default values in Config schema', () => {
      // Volatile fields resolve into Volatile boxes; unwrap with get().
      const parsed = Config({});
      const autoResume = parsed.autoResume?.get();
      expect(autoResume).toBeDefined();
      expect(autoResume?.enabled).toBe(true);
      expect(autoResume?.maxRetries).toBe(3);
      expect(autoResume?.message).toBe('继续。按原计划继续执行当前任务，不要停止。');
    });

    it('should respect custom autoResume configurations', () => {
      const custom = Config({
        autoResume: {
          enabled: false,
          maxRetries: 5,
          message: '自定义继续指令',
        },
      });
      const autoResume = custom.autoResume?.get();
      expect(autoResume?.enabled).toBe(false);
      expect(autoResume?.maxRetries).toBe(5);
      expect(autoResume?.message).toBe('自定义继续指令');
    });
  });

  describe('Model Format Errors and Retries Remaining (Defect D3)', () => {
    const realD3Error =
      'Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call: Function call is empty - no input to parse. Please retry with a properly formatted function call\nRetries remaining: 3';

    it('should classify model format error with Retries remaining: 3 as retryable and engineInternal', () => {
      const res = classifyError(realD3Error);
      expect(res.retryable).toBe(true);
      expect(res.signature).toBe('model_format_error');
      expect(res.engineInternal).toBe(true);
      expect(res.retriesRemaining).toBe(3);
      expect(isTransientRetryableError(realD3Error)).toBe(true);
      expect(isInternalEngineRetryError(realD3Error)).toBe(true);
    });

    it('should parse retries remaining correctly', () => {
      expect(parseRetriesRemaining(realD3Error)).toBe(3);
      expect(parseRetriesRemaining('Retries remaining: 1')).toBe(1);
      expect(parseRetriesRemaining('Retries remaining: 0')).toBe(0);
      expect(parseRetriesRemaining('No retries here')).toBeUndefined();
    });

    it('should classify model format error with Retries remaining: 0 as terminal non-retryable', () => {
      const exhaustedError =
        'Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call: Function call is empty - no input to parse. Please retry with a properly formatted function call\nRetries remaining: 0';
      const res = classifyError(exhaustedError);
      expect(res.retryable).toBe(false);
      expect(res.reason).toBe('model_format_retries_exhausted');
      expect(res.retriesRemaining).toBe(0);
      expect(isTransientRetryableError(exhaustedError)).toBe(false);
      expect(isInternalEngineRetryError(exhaustedError)).toBe(false);
      expect(formatExhaustedRetryError(0, exhaustedError, 'model_format_error')).toContain(
        '模型输出格式错误重试耗尽'
      );
    });

    it('should classify generic model format error without retries remaining as retryable and engineInternal', () => {
      const genericFormatError =
        'Error: Malformed function call: Failed to parse function call: Function call is empty - no input to parse.';
      const res = classifyError(genericFormatError);
      expect(res.retryable).toBe(true);
      expect(res.signature).toBe('model_format_error');
      expect(res.engineInternal).toBe(true);
      expect(isTransientRetryableError(genericFormatError)).toBe(true);
    });
  });

  describe('503 / 502 / EOF / Connection Refused Network Errors', () => {
    it('should classify HTTP 503 / UNAVAILABLE / 502 / 429 as transient network_error', () => {
      const samples = [
        'HTTP 503 Service Unavailable',
        'status 503: UNAVAILABLE: upstream service is temporarily overloaded',
        '502 Bad Gateway',
        '429 Too Many Requests: Rate limit exceeded',
        'gRPC error: RESOURCE_EXHAUSTED',
      ];
      for (const sample of samples) {
        const res = classifyError(sample);
        expect(res.retryable).toBe(true);
        expect(res.signature).toBe('network_error');
        expect(isTransientRetryableError(sample)).toBe(true);
      }
    });

    it('should classify OAuth EOF / stream EOF as transient network_error', () => {
      const samples = [
        'error reading from server: unexpected EOF',
        'OAuth request failed: stream error: EOF',
        'connection closed: EOF',
      ];
      for (const sample of samples) {
        const res = classifyError(sample);
        expect(res.retryable).toBe(true);
        expect(res.signature).toBe('network_error');
        expect(isTransientRetryableError(sample)).toBe(true);
      }
    });

    it('should classify Chinese connection errors as transient network_error', () => {
      const samples = [
        '连接拒绝: 目标主机积极拒绝，无法连接',
        '网络异常: 请求超时，请稍后重试',
        '远程主机强迫关闭了一个现有的连接 (连接重置)',
      ];
      for (const sample of samples) {
        const res = classifyError(sample);
        expect(res.retryable).toBe(true);
        expect(res.signature).toBe('network_error');
        expect(isTransientRetryableError(sample)).toBe(true);
      }
    });
  });

  describe('TLS / HTTP2 Transport-Layer Transient Errors (W15 D3 follow-up)', () => {
    /** Real production capture: the cascade that died before this fix. */
    const productionErrorPayload = {
      step_index: 180,
      source: 'SYSTEM',
      type: 'ERROR_MESSAGE',
      status: 'DONE',
      error:
        'API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": local error: tls: bad record MAC',
      created_at: '2026-10-04T17:00:56Z',
    };
    const productionErrorWrapper = `unknown agent error (raw: ${JSON.stringify(productionErrorPayload)})`;

    const transportSamples: Array<[layer: string, message: string]> = [
      // TLS record / handshake layer
      ['tls bad record MAC', 'local error: tls: bad record MAC'],
      ['tls first record is not a handshake', 'tls: first record does not look like a TLS handshake'],
      ['tls handshake failure', 'net/http: TLS handshake failure'],
      ['tls timeout', 'write: tls: timeout'],
      ['i/o timeout', 'read tcp 10.0.0.1:52000->142.250.1.1:443: i/o timeout'],
      ['tls protocol version not supported', 'remote error: tls: protocol version not supported'],
      ['missing TLS close_notify', 'remote end closed connection without sending TLS close_notify'],
      // TCP / socket teardown layer
      ['connection reset by peer', 'read tcp 127.0.0.1:5000->127.0.0.1:7778: connection reset by peer'],
      ['forcibly closed by remote host', 'An existing connection was forcibly closed by the remote host.'],
      ['closed network connection', 'use of closed network connection'],
      ['broken pipe', 'write tcp 10.0.0.5:443: write: broken pipe'],
      ['server closed idle connection', 'http2: server closed idle connection'],
      ['dial tcp failure', 'dial tcp: connectex: No connection could be made because the target machine actively refused it.'],
      ['DNS resolution failure', 'dial tcp: lookup daily-cloudcode-pa.googleapis.com on 8.8.8.8:53: no such host'],
      // HTTP/2 layer
      ['http2 GOAWAY', 'http2: server sent GOAWAY and closed the connection'],
      ['http2 client connection lost', 'http2: client connection lost'],
      ['http2 connection error', 'http2: connection error: unexpected EOF'],
      // WebSocket layer
      ['websocket abnormal close 1006', 'read: websocket: close 1006 (abnormal closure): unexpected EOF'],
      // D3 baseline coverage must survive the composition
      ['D3 baseline connection closed', 'connection closed: EOF'],
      ['D3 baseline Chinese connection reset', '远程主机强迫关闭了一个现有的连接 (连接重置)'],
    ];

    it.each(transportSamples)(
      'should classify %s as transient network_error with backoff retry',
      (_layer, message) => {
        const res = classifyError(message);
        expect(res.retryable).toBe(true);
        expect(res.signature).toBe('network_error');
        expect(res.reason).toBeUndefined();
        expect(res.engineInternal).toBeUndefined();
        expect(isTransientRetryableError(message)).toBe(true);
        expect(isNetworkError(message)).toBe(true);
        // network_error contract: capped retries + exponential backoff, never an immediate give-up.
        expect(getMaxRetriesForSignature(res.signature)).toBe(3);
        expect(getAutoResumeBackoffMs(0, res.signature)).toBe(2000);
        expect(getAutoResumeBackoffMs(2, res.signature)).toBe(10000);
      },
    );

    it('should classify the real production "tls: bad record MAC" cascade failure as retryable', () => {
      // The trajectory payload shape the bridge actually receives.
      expect(extractErrorMessage(productionErrorPayload)).toBe(productionErrorPayload.error);
      const inputs: unknown[] = [
        productionErrorPayload,
        productionErrorWrapper,
        new Error(productionErrorWrapper),
      ];
      for (const input of inputs) {
        const res = classifyError(input);
        expect(res.retryable).toBe(true);
        expect(res.signature).toBe('network_error');
      }
    });

    it('should keep the transport pattern layer-scoped (cert/verification faults excluded)', () => {
      expect(TLS_TRANSPORT_ERROR_PATTERN.test('local error: tls: bad record MAC')).toBe(true);
      expect(TLS_TRANSPORT_ERROR_PATTERN.test('http2: server sent GOAWAY and closed the connection')).toBe(true);
      expect(TLS_TRANSPORT_ERROR_PATTERN.test('x509: certificate signed by unknown authority')).toBe(false);
      expect(TLS_TRANSPORT_ERROR_PATTERN.test('tls: failed to verify certificate')).toBe(false);
    });

    // ---------------------------------------------------------------------
    // REVERSE CASES (D3 core boundary — must never regress to retryable)
    // ---------------------------------------------------------------------
    it('REVERSE: "Retries remaining: 0" model format error stays terminal, NOT network_error', () => {
      const exhaustedError =
        'Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call: Function call is empty - no input to parse. Please retry with a properly formatted function call\nRetries remaining: 0';
      const res = classifyError(exhaustedError);
      expect(res.retryable).toBe(false);
      expect(res.reason).toBe('model_format_retries_exhausted');
      expect(res.retriesRemaining).toBe(0);
      expect(res.signature).toBeUndefined();
      expect(isTransientRetryableError(exhaustedError)).toBe(false);
      expect(isInternalEngineRetryError(exhaustedError)).toBe(false);
    });

    it('REVERSE: TLS/network keywords cannot rescue a "Retries remaining: 0" exhausted error', () => {
      const exhaustedTlsError = `${productionErrorWrapper}\nRetries remaining: 0`;
      const res = classifyError(exhaustedTlsError);
      // Authoritative entry point is classifyError (index.ts resume/settle path);
      // the retries-remaining gate runs BEFORE the transient network table.
      expect(res.retryable).toBe(false);
      expect(res.reason).toBe('model_format_retries_exhausted');
      expect(res.retriesRemaining).toBe(0);
      expect(res.signature).not.toBe('network_error');
      expect(isTransientRetryableError(exhaustedTlsError)).toBe(false);

      const exhaustedFormatWithEof =
        'Malformed function call: Failed to parse function call\nunexpected EOF\nRetries remaining: 0';
      const res2 = classifyError(exhaustedFormatWithEof);
      expect(res2.retryable).toBe(false);
      expect(res2.reason).toBe('model_format_retries_exhausted');
      expect(res2.signature).toBeUndefined();
    });

    it('REVERSE: TLS certificate/verification failures stay terminal (not transient transport)', () => {
      const certErrors = [
        'x509: certificate signed by unknown authority',
        'tls: failed to verify certificate: x509: certificate signed by unknown authority',
        'x509: certificate is valid for gemini.google.com, not daily-cloudcode-pa.googleapis.com',
      ];
      for (const err of certErrors) {
        const res = classifyError(err);
        expect(res.retryable).toBe(false);
        expect(res.reason).toBe('unclassified_terminal_error');
        expect(isTransientRetryableError(err)).toBe(false);
      }
    });

    it('REVERSE: terminal markers still win over TLS keywords', () => {
      const deliveryFailed =
        'DELIVERY FAILED for abc-123: message not visible in transcript after send + resend. The conversation may be in a hub-side dead state after local error: tls: bad record MAC';
      expect(classifyError(deliveryFailed).reason).toBe('terminal_delivery_failed');
      expect(classifyError(deliveryFailed).retryable).toBe(false);

      const permissionDenied = 'HTTP 403 Forbidden: tls: bad record MAC';
      expect(classifyError(permissionDenied).reason).toBe('terminal_permission_denied');
      expect(classifyError(permissionDenied).retryable).toBe(false);

      const authPermanent = 'OAuth 凭据已失效，请重新登录 Antigravity (http2: server sent GOAWAY)';
      expect(classifyError(authPermanent).reason).toBe('terminal_auth_permanent_failure');
      expect(classifyError(authPermanent).retryable).toBe(false);
    });

    it('REVERSE: clean websocket close (1000) is not swept into the network bucket', () => {
      const cleanClose = 'read: websocket: close 1000 (normal)';
      expect(TLS_TRANSPORT_ERROR_PATTERN.test(cleanClose)).toBe(false);
      expect(classifyError(cleanClose).retryable).toBe(false);
    });
  });
});
