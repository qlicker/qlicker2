import { generateMeteorId } from '../utils/meteorId.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import config from '../config/index.js';

const AI_RESPONSE_FORMAT_ATTEMPTS = 2;
const MAX_TOOL_CALLS_PER_RESPONSE = 10;
const MAX_AI_CHAT_CONTENT_CHARS = 100_000;
const MAX_AI_CHAT_THINKING_CHARS = 100_000;
export const AI_REQUEST_TIMEOUT_MIN_SECONDS = 10;
export const AI_REQUEST_TIMEOUT_MAX_SECONDS = 1_800;

export function normalizeAiRequestTimeoutSeconds(value) {
  const fallback = Math.round(config.aiBackendRequestTimeoutMs / 1_000);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(AI_REQUEST_TIMEOUT_MIN_SECONDS, Math.min(AI_REQUEST_TIMEOUT_MAX_SECONDS, Math.round(parsed)));
}

class AiResponseFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiResponseFormatError';
  }
}

export class AiBackendHttpError extends Error {
  constructor(status, detail = '') {
    const normalizedDetail = String(detail || '').trim();
    super(`AI backend request failed (${status})${normalizedDetail ? `: ${normalizedDetail}` : ''}`);
    this.name = 'AiBackendHttpError';
    this.status = status;
    this.detail = normalizedDetail;
  }
}

export function normalizeAiUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('AI backend URL must use HTTP or HTTPS');
  if (parsed.username || parsed.password) throw new Error('AI backend URLs cannot contain credentials');
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function ipv4Kind(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return 'invalid';
  if (parts[0] === 0 || parts[0] >= 224) return 'blocked';
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return 'blocked';
  if (parts[0] === 169 && parts[1] === 254) return 'blocked';
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return 'blocked';
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return 'blocked';
  if (parts[0] === 198 && [18, 19].includes(parts[1])) return 'blocked';
  if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return 'blocked';
  if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return 'blocked';
  if (parts[0] === 127) return 'private';
  if (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)) return 'private';
  return 'public';
}

function addressKind(address) {
  if (isIP(address) === 4) return ipv4Kind(address);
  const normalized = String(address || '').toLowerCase();
  if (normalized === '::' || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff')) return 'blocked';
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')) return 'private';
  if (normalized.startsWith('::ffff:')) {
    const tail = normalized.slice(7);
    if (isIP(tail) === 4) return ipv4Kind(tail);
    const words = tail.split(':');
    if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
      const high = Number.parseInt(words[0], 16);
      const low = Number.parseInt(words[1], 16);
      return ipv4Kind(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return 'blocked';
  }
  return 'public';
}

async function validateAiEndpoint(value) {
  const normalized = normalizeAiUrl(value);
  const parsed = new URL(normalized);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (['169.254.169.254', 'metadata.google.internal', 'metadata'].includes(hostname)) {
    throw new Error('AI backend URL points to a prohibited metadata service');
  }
  const privateHostAllowed = config.aiBackendAllowPrivateHosts
    || (config.aiBackendAllowedPrivateHosts || []).includes(hostname);
  let addresses;
  if (isIP(hostname)) addresses = [{ address: hostname }];
  else {
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new Error(`AI backend hostname could not be resolved: ${hostname}`); }
  }
  if (!addresses.length) throw new Error(`AI backend hostname could not be resolved: ${hostname}`);
  addresses.forEach(({ address }) => {
    const kind = addressKind(address);
    if (kind === 'blocked') throw new Error('AI backend URL resolves to a prohibited network address');
    if (kind === 'private' && !privateHostAllowed) {
      throw new Error(`Private AI backend host ${hostname} is not allowed by the server configuration`);
    }
  });
  return normalized;
}

async function aiFetch(value, options = {}, redirectsRemaining = 3) {
  const normalized = await validateAiEndpoint(value);
  const response = await fetch(normalized, { ...options, redirect: 'manual' });
  if (![301, 302, 303, 307, 308].includes(response.status)) return response;
  if (redirectsRemaining <= 0) throw new Error('AI backend returned too many redirects');
  const location = response.headers.get('location');
  if (!location) throw new Error('AI backend returned a redirect without a location');
  const redirectedUrl = new URL(location, normalized).toString();
  const redirectedOptions = { ...options, headers: { ...(options.headers || {}) } };
  if (new URL(redirectedUrl).origin !== new URL(normalized).origin) delete redirectedOptions.headers.authorization;
  if (response.status === 303) {
    redirectedOptions.method = 'GET';
    delete redirectedOptions.body;
  }
  return aiFetch(redirectedUrl, redirectedOptions, redirectsRemaining - 1);
}

export async function fetchAiArtifact(backend, sourcePath, { range } = {}) {
  const path = String(sourcePath || '');
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid AI artifact path');
  const base = new URL(normalizeAiUrl(backend?.url));
  const endpoint = new URL(path, `${base.origin}/`).toString();
  const headers = {};
  if (backend?.apiToken) headers.authorization = `Bearer ${backend.apiToken}`;
  if (range) headers.range = range;
  const requestTimeoutMs = Number.isFinite(Number(backend?.requestTimeoutMs))
    ? Math.max(1_000, Number(backend.requestTimeoutMs))
    : config.aiBackendRequestTimeoutMs;
  return aiFetch(endpoint, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

async function boundedResponseText(response, maximumBytes = 2_000_000) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error('AI backend response exceeded the allowed size');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function boundedJson(response) {
  const text = await boundedResponseText(response);
  try { return JSON.parse(text); }
  catch { throw new AiResponseFormatError('AI backend returned invalid JSON'); }
}

async function backendHttpError(response) {
  const raw = await boundedResponseText(response, 16_000).catch(() => '');
  let detail = String(raw || '').trim();
  if (detail) {
    try {
      const payload = JSON.parse(detail);
      const candidate = payload?.detail ?? payload?.message ?? payload?.error;
      if (candidate !== undefined && candidate !== null) {
        detail = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
      }
    } catch {
      // Keep a plain-text upstream error response as-is.
    }
  }
  detail = detail.replace(/\s+/g, ' ').slice(0, 500);
  return new AiBackendHttpError(response.status, detail);
}

export function normalizeAiBackends(value = []) {
  if (!Array.isArray(value)) return [];
  return value.map((backend) => ({
    id: String(backend?.id || generateMeteorId()),
    name: String(backend?.name || '').trim(),
    type: backend?.type === 'openai' ? 'openai' : 'ollama',
    url: normalizeAiUrl(backend?.url),
    apiToken: String(backend?.apiToken || '').trim(),
    models: (Array.isArray(backend?.models) ? backend.models : []).map((model) => ({
      id: String(model?.id || model?.name || '').trim(),
      name: String(model?.name || model?.id || '').trim(),
      displayName: String(model?.displayName || '').trim().slice(0, 200),
      compatibility: model?.compatibility === 'qrag' ? 'qrag' : '',
      available: model?.available !== false,
    })).filter((model) => model.id && model.name),
  })).filter((backend) => backend.url && backend.id);
}

export function serializeAiBackends(backends = []) {
  return normalizeAiBackends(backends).map((backend) => ({ ...backend, apiToken: '', apiTokenSet: !!backend.apiToken }));
}

export async function discoverOllamaModels(url, apiToken = '') {
  const endpoint = `${normalizeAiUrl(url)}/api/tags`;
  const headers = {};
  if (String(apiToken || '').trim()) headers.authorization = `Bearer ${String(apiToken).trim()}`;
  let response;
  try {
    response = await aiFetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    const detail = error?.cause?.message || error?.message || 'connection failed';
    throw new Error(`Could not reach Ollama model endpoint ${endpoint}: ${detail}. If Qlicker runs in Docker, localhost refers to the server container; use host.docker.internal to reach a service on the host.`);
  }
  if (!response.ok) {
    const detail = String(await boundedResponseText(response, 2_000)).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`Ollama model discovery failed at ${endpoint} (${response.status}${detail ? `: ${detail}` : ''})`);
  }
  const payload = await boundedJson(response);
  return (Array.isArray(payload?.models) ? payload.models : []).map((model) => ({
    id: String(model?.name || '').trim(),
    name: String(model?.name || '').trim(),
    ...(model?.details?.format === 'qrag-expert' ? { compatibility: 'qrag' } : {}),
  })).filter((model) => model.id);
}

export async function discoverOpenAiModels(url, apiToken = '') {
  const endpoint = `${normalizeAiUrl(url)}/models`;
  const headers = {};
  if (String(apiToken || '').trim()) headers.authorization = `Bearer ${String(apiToken).trim()}`;
  let response;
  try {
    response = await aiFetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    const detail = error?.cause?.message || error?.message || 'connection failed';
    throw new Error(`Could not reach OpenAI-compatible model endpoint ${endpoint}: ${detail}. If Qlicker runs in Docker, localhost refers to the server container; use host.docker.internal to reach a service on the host.`);
  }
  if (!response.ok) {
    const detail = String(await boundedResponseText(response, 2_000)).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`OpenAI-compatible model discovery failed at ${endpoint} (${response.status}${detail ? `: ${detail}` : ''})`);
  }
  const payload = await boundedJson(response);
  return (Array.isArray(payload?.data) ? payload.data : []).map((model) => ({
    id: String(model?.id || '').trim(),
    name: String(model?.name || model?.id || '').trim(),
  })).filter((model) => model.id && model.name);
}

export async function requestAiCompletion(backend, modelId, messages, signal = undefined) {
  const result = await requestAiMessage(backend, modelId, messages, [], signal);
  if (!result.content) throw new Error('AI backend returned an empty response');
  return result.content;
}

function parseToolArguments(value, toolName) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') throw new AiResponseFormatError(`AI backend returned non-object arguments for tool ${toolName}`);
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AiResponseFormatError(`AI backend returned non-object arguments for tool ${toolName}`);
    }
    return parsed;
  }
  catch (error) {
    if (error instanceof AiResponseFormatError) throw error;
    throw new AiResponseFormatError(`AI backend returned invalid JSON arguments for tool ${toolName}`);
  }
}

function normalizeMessageContent(value) {
  if (value === undefined || value === null) return '';
  let content;
  if (typeof value === 'string') content = value.trim();
  if (Array.isArray(value)) {
    content = value.map((part) => (part?.type === 'text' ? String(part.text || '') : '')).join('\n').trim();
  }
  if (content === undefined) throw new AiResponseFormatError('AI backend returned chat content in an unsupported format');
  if (content.length > MAX_AI_CHAT_CONTENT_CHARS) throw new AiResponseFormatError('AI backend returned chat content that exceeded the allowed size');
  return content;
}

function normalizeThinkingContent(message) {
  const value = message?.thinking ?? message?.reasoning_content ?? message?.reasoning ?? '';
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new AiResponseFormatError('AI backend returned thinking output in an unsupported format');
  const thinking = value.trim();
  if (thinking.length > MAX_AI_CHAT_THINKING_CHARS) throw new AiResponseFormatError('AI backend returned thinking output that exceeded the allowed size');
  return thinking;
}

function emitThinking(onThinking, thinking) {
  if (!onThinking || !thinking) return;
  try {
    const pending = onThinking(thinking);
    if (pending?.catch) pending.catch(() => {});
  } catch {
    // A progress-display failure must not fail the provider request.
  }
}

async function ollamaStreamPayload(response, onThinking) {
  const reader = response.body?.getReader();
  if (!reader) throw new AiResponseFormatError('AI backend returned an empty response');
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  let parsedAny = false;
  let content = '';
  let thinking = '';
  const toolCalls = [];
  const artifacts = [];

  const parseLine = (line) => {
    const text = line.trim();
    if (!text) return;
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new AiResponseFormatError('AI backend returned invalid streaming JSON'); }
    parsedAny = true;
    if (payload?.error) throw new Error(`AI backend request failed: ${String(payload.error).slice(0, 500)}`);
    const message = payload?.message;
    if (!message || typeof message !== 'object') return;
    if (message.content !== undefined && message.content !== null) content += String(message.content);
    const thinkingChunk = message.thinking ?? message.reasoning_content ?? message.reasoning;
    if (thinkingChunk !== undefined && thinkingChunk !== null) {
      if (typeof thinkingChunk !== 'string') throw new AiResponseFormatError('AI backend returned thinking output in an unsupported format');
      thinking += thinkingChunk;
      if (thinking.length > MAX_AI_CHAT_THINKING_CHARS) throw new AiResponseFormatError('AI backend returned thinking output that exceeded the allowed size');
      emitThinking(onThinking, thinking);
    }
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      if (!Array.isArray(message.tool_calls)) throw new AiResponseFormatError('AI backend returned tool calls in an unsupported format');
      toolCalls.push(...message.tool_calls);
    }
    if (message.qrag_artifacts !== undefined && message.qrag_artifacts !== null) {
      if (!Array.isArray(message.qrag_artifacts)) throw new AiResponseFormatError('AI backend returned artifacts in an unsupported format');
      artifacts.push(...message.qrag_artifacts);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 2_000_000) {
      await reader.cancel();
      throw new Error('AI backend response exceeded the allowed size');
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach(parseLine);
  }
  buffer += decoder.decode();
  if (buffer.trim()) parseLine(buffer);
  if (!parsedAny) throw new AiResponseFormatError('AI backend returned invalid streaming JSON');
  return { message: { content, thinking, tool_calls: toolCalls, qrag_artifacts: artifacts } };
}

function normalizeToolCalls(toolCalls = []) {
  if (!Array.isArray(toolCalls)) throw new AiResponseFormatError('AI backend returned tool calls in an unsupported format');
  if (toolCalls.length > MAX_TOOL_CALLS_PER_RESPONSE) throw new AiResponseFormatError(`AI backend returned more than ${MAX_TOOL_CALLS_PER_RESPONSE} tool calls at once`);
  return (Array.isArray(toolCalls) ? toolCalls : []).map((call, index) => {
    const fn = call?.function || call || {};
    const name = String(fn.name || call?.name || '').trim();
    if (!name) throw new AiResponseFormatError('AI backend returned a tool call without a name');
    return {
      id: String(call?.id || `tool-call-${index}`),
      name,
      arguments: parseToolArguments(fn.arguments ?? call?.arguments, name),
    };
  });
}

function toolDefinitionsForProvider(tools = []) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

async function requestAiMessageOnce(backend, modelId, messages, tools = [], signal = undefined, requestOptions = {}) {
  const headers = { 'content-type': 'application/json' };
  if (backend.apiToken) headers.authorization = `Bearer ${backend.apiToken}`;
  const baseUrl = normalizeAiUrl(backend.url);
  const isOpenAi = backend.type === 'openai';
  const wantsThinking = !isOpenAi && typeof requestOptions.onThinking === 'function';
  const configuredModel = (backend.models || []).find((model) => String(model.id) === String(modelId));
  let backendPath = '';
  try { backendPath = new URL(baseUrl).pathname.replace(/\/+$/, ''); } catch { /* normalizeAiUrl validates this earlier. */ }
  // Qrag's Ollama compatibility endpoint does its own agent/tool loop before it
  // can emit a useful chunk. A failure after streaming headers are sent reaches
  // Node as the opaque transport error "terminated". Its non-streaming endpoint
  // instead returns the completed response or a readable HTTP error.
  const qragCompatibility = configuredModel?.compatibility === 'qrag' || backendPath.endsWith('/ollama');
  const streamThinking = wantsThinking && !qragCompatibility;
  const requestBody = { model: modelId, messages, stream: streamThinking };
  if (wantsThinking) requestBody.think = true;
  if (requestOptions.jsonMode && !isOpenAi) requestBody.format = 'json';
  const requestTimeoutMs = Number.isFinite(Number(backend?.requestTimeoutMs))
    ? Math.max(1_000, Number(backend.requestTimeoutMs))
    : config.aiBackendRequestTimeoutMs;
  if (tools.length > 0) requestBody.tools = toolDefinitionsForProvider(tools);
  const response = await aiFetch(isOpenAi ? `${baseUrl}/chat/completions` : `${baseUrl}/api/chat`, {
    method: 'POST', headers,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
      : AbortSignal.timeout(requestTimeoutMs),
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) throw await backendHttpError(response);
  const payload = streamThinking
    ? await ollamaStreamPayload(response, requestOptions.onThinking)
    : await boundedJson(response);
  const message = isOpenAi ? payload?.choices?.[0]?.message : payload?.message;
  if (!message || typeof message !== 'object') throw new AiResponseFormatError('AI backend returned no chat message');
  const content = normalizeMessageContent(message.content);
  const thinking = normalizeThinkingContent(message);
  if (!streamThinking) emitThinking(requestOptions.onThinking, thinking);
  const toolCalls = normalizeToolCalls(message.tool_calls === undefined || message.tool_calls === null ? [] : message.tool_calls);
  const artifacts = message.qrag_artifacts === undefined || message.qrag_artifacts === null ? [] : message.qrag_artifacts;
  if (!Array.isArray(artifacts)) throw new AiResponseFormatError('AI backend returned artifacts in an unsupported format');
  if (!content && toolCalls.length === 0 && artifacts.length === 0) throw new AiResponseFormatError('AI backend returned an empty response');
  return { content, toolCalls, artifacts, ...(thinking ? { thinking } : {}) };
}

async function requestAiMessageWithOptions(backend, modelId, messages, tools = [], signal = undefined, requestOptions = {}) {
  let formatError = null;
  for (let attempt = 0; attempt < AI_RESPONSE_FORMAT_ATTEMPTS; attempt += 1) {
    const correctiveMessage = attempt === 0 ? [] : [{
      role: 'system',
      content: 'Your previous response was rejected because its format was invalid. No tool call from that rejected response was executed. Continue from the existing conversation and tool results without repeating completed work. Return either a non-empty chat message or valid function tool calls whose arguments are strict JSON objects matching the supplied schemas.',
    }];
    try {
      return await requestAiMessageOnce(backend, modelId, [...messages, ...correctiveMessage], tools, signal, requestOptions);
    } catch (error) {
      if (!(error instanceof AiResponseFormatError)) throw error;
      formatError = error;
    }
  }
  throw new Error(`AI backend repeatedly returned an invalid response: ${formatError?.message || 'unknown format error'}`);
}

export async function requestAiMessage(backend, modelId, messages, tools = [], signal = undefined, onThinking = undefined) {
  return requestAiMessageWithOptions(backend, modelId, messages, tools, signal, { onThinking });
}

export async function requestAiJsonMessage(backend, modelId, messages, signal = undefined, onThinking = undefined) {
  return requestAiMessageWithOptions(backend, modelId, messages, [], signal, { jsonMode: true, onThinking });
}
