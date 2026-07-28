"use strict";

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function extractContentBlock(value) {
  const matches = [...String(value ?? "").matchAll(/<content\b[^>]*>([\s\S]*?)<\/content>/gi)];
  return matches.length ? matches.map((match) => match[1]).join("\n\n") : value;
}

function cleanAssistantContent(value) {
  let text = String(value ?? "");
  text = extractContentBlock(text);
  text = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(thinking|analysis|reasoning|style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\{\{ANIMA_STATUS::[^}]+\}\}/gi, "")
    .replace(/!\[[^\]]*]\(data:[^)]+\)/gi, "[图片已省略]")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|li|blockquote|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return normalizeWhitespace(text);
}

function cleanMessage(message, floor) {
  const isUser = Boolean(message?.is_user) || message?.role === "user";
  const isOpening = floor === 0;
  const raw = String(message?.mes ?? message?.content ?? "");
  const content = isUser || isOpening ? normalizeWhitespace(raw) : cleanAssistantContent(raw);
  return {
    floor,
    role: isUser ? "user" : "assistant",
    name: String(message?.name ?? (isUser ? "User" : "Assistant")).trim(),
    send_date: String(message?.send_date ?? ""),
    content,
  };
}

function cleanMessages(messages, startFloor = 0, endFloor = Number.MAX_SAFE_INTEGER) {
  return (Array.isArray(messages) ? messages : [])
    .map((message, index) => cleanMessage(message, Number(message?.floor ?? index)))
    .filter((message) => message.floor >= startFloor && message.floor <= endFloor)
    .filter((message) => message.content);
}

function formatMessages(messages) {
  return cleanMessages(messages)
    .map((message) => {
      const speaker = message.role === "user"
        ? `用户${message.name ? `:${message.name}` : ""}`
        : message.name || "角色";
      return `[楼层 ${message.floor}] [${speaker}]` +
        `${message.send_date ? ` [${message.send_date}]` : ""}\n${message.content}`;
    })
    .join("\n\n");
}

module.exports = {
  cleanAssistantContent,
  cleanMessage,
  cleanMessages,
  formatMessages,
};
