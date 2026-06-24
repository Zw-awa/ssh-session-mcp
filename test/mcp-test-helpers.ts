/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

type ToolHandler = (...args: any[]) => any;

type RegisteredToolCompat = {
  handler?: ToolHandler;
  callback?: ToolHandler;
};

type ToolServerCompat = {
  _registeredTools: Record<string, RegisteredToolCompat>;
};

export function getRegisteredToolHandler(server: ToolServerCompat, name: string): ToolHandler {
  const tool = server._registeredTools[name];

  if (!tool) {
    throw new Error(`Tool ${name} is not registered`);
  }

  const handler = tool.handler ?? tool.callback;

  if (typeof handler !== 'function') {
    throw new Error(`Tool ${name} does not expose a callable handler`);
  }

  return handler;
}
