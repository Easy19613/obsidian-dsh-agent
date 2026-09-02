// ACP v1 (Agent Client Protocol) minimal message types.
// Wire reference: https://agentclientprotocol.com
// Server under test: @deepseek-ai/dsh-acp@0.1.1-rc.2 (deepseek-harness-acp).
// Implemented locally instead of depending on @agentclientprotocol/sdk to keep
// the plugin bundle small and the protocol surface explicit.

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface AcpImplementation {
  name: string;
  version: string;
}

export interface AcpPromptCapabilities {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

export interface AcpAgentCapabilities {
  promptCapabilities: AcpPromptCapabilities;
}

export interface AcpAuthMethod {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo: AcpImplementation;
  agentCapabilities: AcpAgentCapabilities;
  authMethods: AcpAuthMethod[];
}

export interface AcpNewSessionParams {
  cwd: string;
  mcpServers?: unknown[];
  additionalDirectories?: string[];
}

export interface AcpNewSessionResult {
  sessionId: string;
  modes?: unknown[];
  agents?: unknown[];
}

export type AcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' }
  | { type: 'resource_link'; name: string; uri: string; title?: string; description?: string };

export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpPromptBlock[];
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'cancelled' | 'refusal';

export interface AcpPromptResult {
  stopReason: AcpStopReason;
}

export interface AcpCancelNotificationParams {
  sessionId: string;
}

export interface AcpAgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: { type: 'text'; text: string } | Record<string, unknown>;
}

export interface AcpSessionUpdateNotification {
  sessionId: string;
  update: AcpAgentMessageChunkUpdate;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once';
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: { toolCallId: string };
  options: AcpPermissionOption[];
}

export type AcpRequestPermissionResult = {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
};

export function textBlock(text: string): AcpPromptBlock {
  return { type: 'text', text };
}
